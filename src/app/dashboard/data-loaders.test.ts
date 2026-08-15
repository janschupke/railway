import { beforeEach, describe, expect, it, vi } from "vitest";
import { logRecords } from "@/test/log-capture";
import type { RailwaySession } from "@/lib/auth/session";

const getSession = vi.fn<() => Promise<RailwaySession | null>>();
const listProjects = vi.fn();
const getProjectContainers = vi.fn();
const getProjectMetrics = vi.fn();
const getEnvironmentVolumes = vi.fn();
const cachedRegions = vi.fn();

vi.mock("@/lib/auth/server", () => ({ getSession: () => getSession() }));
vi.mock("@/lib/railway/projects", () => ({
  listProjects: (...args: unknown[]) => listProjects(...args),
  getProjectContainers: (...args: unknown[]) => getProjectContainers(...args),
}));
vi.mock("@/lib/railway/metrics", () => ({
  getProjectMetrics: (...args: unknown[]) => getProjectMetrics(...args),
}));
vi.mock("@/lib/railway/volumes", () => ({
  getEnvironmentVolumes: (...args: unknown[]) => getEnvironmentVolumes(...args),
}));
vi.mock("@/lib/railway/regions", () => ({
  cachedRegions: (...args: unknown[]) => cachedRegions(...args),
}));

/*
 * Four loaders across four modules now, driven together because that is how the page uses
 * them: `managedNames` reads through `loadContainers`' own `cache()` memo, and the cases
 * asserting that the second call costs no round trip only mean anything from here.
 */
const { loadContainers, managedNames } = await import("./data-containers");
const { deployRegions } = await import("./data-regions");
const { loadDashboardShell } = await import("./data-shell");
const { RailwayApiError } = await import("@/lib/railway/errors");
/**
 * `METRICS_POLL_MS`, overridable per test without touching `process.env`.
 *
 * It used to be `process.env.METRICS_POLL_MS = "0"` around a try/finally, and that is a
 * process-global — vitest runs several test files in one process, so the window in which
 * this file said "metrics are off" was a window in which *other* files' code read a zero
 * too. `src/app/api/watch/route.integration.test.ts` reads it at stream open, and with a
 * zero there no `stale` frame is ever due; it failed intermittently, only under
 * `--coverage`, and looked like a bug in the watch route. A module mock is scoped to this
 * file, so nothing outside it can observe the override.
 */
let metricsPollMs: number | null = null;
vi.mock("@/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/env")>();
  return {
    ...actual,
    // null means "whatever the environment says", so every test that does not care about
    // this reads the real default rather than a number copied into this file.
    env: () => ({
      ...actual.env(),
      ...(metricsPollMs === null ? {} : { METRICS_POLL_MS: metricsPollMs }),
    }),
  };
});

const session: RailwaySession = {
  user: { id: "u1", name: "Ada", email: "ada@example.com" },
  accessToken: "token",
  refreshToken: "refresh",
  expiresAt: 9_999_999_999,
  scope: "openid project:admin",
};

const projects = [
  {
    id: "p1",
    name: "Demo",
    environments: [
      { id: "e1", name: "production" },
      { id: "e2", name: "staging" },
    ],
  },
  { id: "p2", name: "Other", environments: [{ id: "e3", name: "production" }] },
];

const workspaces = [{ id: "ws1", name: "Acme" }];

beforeEach(() => {
  getSession.mockReset().mockResolvedValue(session);
  listProjects
    .mockReset()
    .mockResolvedValue({ viewer: {}, projects, workspaces, failures: [] });
  getProjectMetrics.mockReset().mockResolvedValue({ metrics: {}, spend: null });
  getEnvironmentVolumes.mockReset().mockResolvedValue({});
  // Per test, so an override cannot outlive the case that wanted it.
  metricsPollMs = null;
  getProjectContainers
    .mockReset()
    .mockResolvedValue({ project: projects[0], containers: [] });
});

describe("loadDashboardShell", () => {
  it("returns null without a session, leaving the redirect to routing", async () => {
    getSession.mockResolvedValue(null);
    expect(await loadDashboardShell()).toBeNull();
  });

  it("never reads containers", async () => {
    /*
     * The load-bearing property of the split: the shell is what the user waits for
     * before anything renders, so a second Railway round trip must not be in it. Fails
     * the moment someone re-inlines the container read for convenience.
     */
    await loadDashboardShell();
    expect(getProjectContainers).not.toHaveBeenCalled();
  });

  it("defaults to the first project and its first environment", async () => {
    const shell = await loadDashboardShell();

    expect(shell?.project?.id).toBe("p1");
    expect(shell?.environment?.id).toBe("e1");
  });

  it("honours an explicit selection", async () => {
    const shell = await loadDashboardShell("p2", "e3");

    expect(shell?.project?.id).toBe("p2");
    expect(shell?.environment?.id).toBe("e3");
  });

  it("falls back when the selection names something that no longer exists", async () => {
    // A stale bookmark must not blank the dashboard.
    const shell = await loadDashboardShell("gone", "gone");
    expect(shell?.project?.id).toBe("p1");
    expect(shell?.environment?.id).toBe("e1");
  });

  it("reports a substituted project rather than swapping it silently", async () => {
    // Showing another project's containers under a link that names a specific one is
    // the kind of quiet wrong answer a user cannot detect.
    const shell = await loadDashboardShell("gone");
    expect(shell?.droppedSelection).toBe(true);
  });

  it("does not call an unknown environment a substitution", async () => {
    // The project asked for is the one shown; its default environment is not a swap.
    const shell = await loadDashboardShell("p1", "gone");

    expect(shell?.droppedSelection).toBe(false);
    expect(shell?.environment?.id).toBe("e1");
  });

  it("does not report a substitution when there was nothing to substitute", async () => {
    listProjects.mockResolvedValue({
      viewer: {},
      projects: [],
      workspaces,
      failures: [],
    });

    const shell = await loadDashboardShell("gone");

    expect(shell?.droppedSelection).toBe(false);
  });

  it("names the scopes Railway withheld, so the page can say why the list is empty", async () => {
    // An empty list caused by a denied scope needs the opposite advice from an empty
    // list that is simply empty — this is what lets the page tell them apart.
    getSession.mockResolvedValue({ ...session, scope: "openid email" });

    const shell = await loadDashboardShell();

    expect(shell?.missingScopes).toEqual([
      "project:admin",
      "workspace:viewer",
      "offline_access",
    ]);
  });

  it("reports no missing scopes when consent granted everything that matters", async () => {
    getSession.mockResolvedValue({
      ...session,
      scope: "openid email profile offline_access project:admin workspace:viewer",
    });

    expect((await loadDashboardShell())?.missingScopes).toEqual([]);
  });

  it("degrades to an explanation when the project list fails", async () => {
    // A Railway outage should render the shell with a reason, not an error boundary.
    listProjects.mockRejectedValue(
      new RailwayApiError("Rate limited by Railway", { kind: "rate_limit" }),
    );

    const shell = await loadDashboardShell();

    expect(shell?.error).toContain("rate limit");
    expect(shell?.projects).toEqual([]);
    // The kind is what lets the page offer a retry here and re-consent on an auth
    // failure, instead of showing both every time.
    expect(shell?.errorKind).toBe("rate_limit");
  });

  it("leaves the failure kind unset for a non-Railway error", async () => {
    listProjects.mockRejectedValue(new Error("socket hang up"));
    expect((await loadDashboardShell())?.errorKind).toBeNull();
  });

  it("uses a generic message for a non-Railway failure", async () => {
    listProjects.mockRejectedValue(new Error("socket hang up"));

    const shell = await loadDashboardShell();

    expect(shell?.error).toMatch(
      /^Could not load your Railway projects\. Reference \w+\.$/,
    );
    expect(shell?.error).not.toContain("socket");
  });

  it("handles a user with no projects shared", async () => {
    listProjects.mockResolvedValue({
      viewer: {},
      projects: [],
      workspaces,
      failures: [],
    });

    const shell = await loadDashboardShell();

    expect(shell?.projects).toEqual([]);
    expect(shell?.project).toBeNull();
    expect(shell?.environment).toBeNull();
    expect(shell?.error).toBeNull();
  });

  it("handles a project with no environments", async () => {
    listProjects.mockResolvedValue({
      viewer: {},
      projects: [{ id: "p9", name: "Empty", environments: [] }],
      workspaces,
      failures: [],
    });

    const shell = await loadDashboardShell();

    expect(shell?.project?.id).toBe("p9");
    expect(shell?.environment).toBeNull();
  });

  it("carries the workspaces a project could be created in", async () => {
    expect((await loadDashboardShell())?.workspaces).toEqual(workspaces);
  });

  it("carries an empty workspace list when the project read failed", async () => {
    // The create dialog reads `.length` off this. A failed read has to leave a list that
    // says "nothing to choose", not one that says nothing at all.
    listProjects.mockRejectedValue(new Error("socket hang up"));

    expect((await loadDashboardShell())?.workspaces).toEqual([]);
  });

  it("carries the signed-in identity for the header", async () => {
    const shell = await loadDashboardShell();
    expect(shell?.user).toEqual({ name: "Ada", email: "ada@example.com" });
  });
});

describe("loadContainers", () => {
  it("reads the selected environment with the session token", async () => {
    getProjectContainers.mockResolvedValue({
      project: projects[0],
      containers: [{ serviceId: "s1" }],
    });

    const data = await loadContainers("p1", "e1");

    expect(getProjectContainers).toHaveBeenCalledWith("token", "p1", "e1");
    expect(data.containers).toHaveLength(1);
    expect(data.error).toBeNull();
  });

  it("degrades to an explanation rather than throwing into the boundary", async () => {
    getProjectContainers.mockRejectedValue(
      new RailwayApiError("boom", { kind: "server" }),
    );

    const data = await loadContainers("p1", "e1");

    expect(data.containers).toEqual([]);
    expect(data.error).toContain("server error");
  });

  it("does not leak a non-Railway failure's text", async () => {
    getProjectContainers.mockRejectedValue(new Error("socket hang up"));

    const data = await loadContainers("p1", "e1");

    expect(data.error).toMatch(
      /^Could not load containers for this environment\. Reference \w+\.$/,
    );
    expect(data.error).not.toContain("socket");
  });

  it("is inert without a session", async () => {
    // The shell already redirected; this is a guard, not a path.
    getSession.mockResolvedValue(null);

    const data = await loadContainers("p1", "e1");

    expect(data).toEqual({
      containers: [],
      error: null,
      metrics: {},
      volumes: {},
      spend: null,
    });
    expect(getProjectContainers).not.toHaveBeenCalled();
    expect(getProjectMetrics).not.toHaveBeenCalled();
  });

  describe("managedNames", () => {
    it("names only what this app created, without its prefix", async () => {
      // A collision is only possible inside this app's own namespace: it prefixes what
      // it creates, and a service made elsewhere is listed for context and nothing else.
      getProjectContainers.mockResolvedValue({
        project: projects[0],
        containers: [
          { serviceId: "s1", managed: true, displayName: "cache" },
          { serviceId: "s2", managed: false, displayName: "postgres" },
        ],
      });

      await expect(managedNames("p1", "e1")).resolves.toEqual(["cache"]);
    });

    it("answers with nothing rather than rejecting when the read failed", async () => {
      // Handed to a client component as an unawaited promise, so a rejection here is an
      // error in the client tree rather than a check that quietly did not run.
      getProjectContainers.mockRejectedValue(new Error("socket hang up"));

      await expect(managedNames("p1", "e1")).resolves.toEqual([]);
    });
  });

  describe("the usage read", () => {
    const usage = {
      metrics: {
        s1: {
          serviceId: "s1",
          cpuCores: 0.25,
          memoryGb: 1.5,
          sampledAt: 1_760_000_000,
        },
      },
      spend: {
        currentUsage: 18.4,
        periodStart: "2026-08-01T00:00:00Z",
        periodEnd: "2026-08-31T00:00:00Z",
        workspaceName: "Acme",
      },
    };

    it("returns usage alongside the containers", async () => {
      getProjectContainers.mockResolvedValue({
        project: projects[0],
        containers: [{ serviceId: "s1" }],
      });
      getProjectMetrics.mockResolvedValue(usage);

      const data = await loadContainers("p1", "e1");

      expect(getProjectMetrics).toHaveBeenCalledWith("token", "p1", "e1");
      expect(data.metrics.s1?.cpuCores).toBe(0.25);
      expect(data.spend?.currentUsage).toBe(18.4);
    });

    it("still returns the containers when the usage read fails", async () => {
      /*
       * The whole argument for Query.metrics being optional: a readout this app degrades
       * out of must not take the container list with it. Caught separately for exactly
       * this reason rather than sharing the list's catch.
       */
      getProjectContainers.mockResolvedValue({
        project: projects[0],
        containers: [{ serviceId: "s1" }],
      });
      getProjectMetrics.mockRejectedValue(new Error("network"));

      const data = await loadContainers("p1", "e1");

      expect(data.containers).toHaveLength(1);
      expect(data.error).toBeNull();
      expect(data.metrics).toEqual({});
      expect(data.spend).toBeNull();
    });

    it("still returns the spend figure when the container read fails", async () => {
      // The mirror. They are independent reads shown in different places, and collapsing
      // them into one failure would lose the only real cost number on the page.
      getProjectContainers.mockRejectedValue(
        new RailwayApiError("boom", { kind: "server" }),
      );
      getProjectMetrics.mockResolvedValue(usage);

      const data = await loadContainers("p1", "e1");

      expect(data.containers).toEqual([]);
      expect(data.error).toContain("server error");
      expect(data.spend?.currentUsage).toBe(18.4);
    });

    it("does not ask for usage at all when metrics are switched off", async () => {
      // METRICS_POLL_MS=0 has to cost zero requests, not merely fewer.
      metricsPollMs = 0;
      getProjectContainers.mockResolvedValue({
        project: projects[0],
        containers: [{ serviceId: "s1" }],
      });

      const data = await loadContainers("p1", "e1");

      expect(getProjectMetrics).not.toHaveBeenCalled();
      expect(data.metrics).toEqual({});
      expect(data.spend).toBeNull();
    });
  });

  describe("volumes", () => {
    const volume = {
      svc_1: {
        serviceId: "svc_1",
        volumeId: "vol_1",
        mountPath: "/data",
        sizeMB: 500,
        currentSizeMB: 4,
      },
    };

    it("returns where each container keeps its data, keyed by service", async () => {
      getProjectContainers.mockResolvedValue({
        project: projects[0],
        containers: [{ serviceId: "svc_1" }],
      });
      getEnvironmentVolumes.mockResolvedValue(volume);

      const data = await loadContainers("p1", "e1");

      expect(getEnvironmentVolumes).toHaveBeenCalledWith("token", "e1");
      expect(data.volumes.svc_1?.mountPath).toBe("/data");
    });

    it("keeps reading volumes when the usage readout is switched off", async () => {
      /*
       * METRICS_POLL_MS exists to turn off a *polled* readout on a plan whose rate limit
       * cannot afford it. A volume is a property of the container rather than a sample of
       * it, and the destroy dialog's offer to take the data depends on knowing it is there
       * — so switching the usage readout off must not quietly start orphaning volumes.
       */
      metricsPollMs = 0;
      getProjectContainers.mockResolvedValue({
        project: projects[0],
        containers: [{ serviceId: "svc_1" }],
      });
      getEnvironmentVolumes.mockResolvedValue(volume);

      const data = await loadContainers("p1", "e1");

      expect(getProjectMetrics).not.toHaveBeenCalled();
      expect(getEnvironmentVolumes).toHaveBeenCalledTimes(1);
      expect(data.volumes.svc_1?.volumeId).toBe("vol_1");
    });

    it("still returns the containers when the volume read fails", async () => {
      // Degrades to nothing, which is the same value "no container here has a volume"
      // produces — and every consequence of it is the conservative one.
      getProjectContainers.mockResolvedValue({
        project: projects[0],
        containers: [{ serviceId: "svc_1" }],
      });
      getEnvironmentVolumes.mockRejectedValue(new Error("network"));

      const data = await loadContainers("p1", "e1");

      expect(data.containers).toHaveLength(1);
      expect(data.error).toBeNull();
      expect(data.volumes).toEqual({});
    });

    it("awaits the volume read even when the container read failed", async () => {
      /*
       * Not about the value — it is about the request not outliving the render that started
       * it. An unawaited promise on the error path is a floating rejection, which is how an
       * optional read takes a process down.
       */
      getProjectContainers.mockRejectedValue(
        new RailwayApiError("boom", { kind: "server" }),
      );
      getEnvironmentVolumes.mockResolvedValue(volume);

      const data = await loadContainers("p1", "e1");

      expect(data.containers).toEqual([]);
      expect(data.volumes.svc_1?.mountPath).toBe("/data");
    });
  });
});

describe("deployRegions", () => {
  const OREGON = {
    id: "us-west2",
    label: "US West (Oregon)",
    country: "United States",
  };

  beforeEach(() => {
    getSession.mockReset();
    getSession.mockResolvedValue(session);
    cachedRegions.mockReset();
  });

  it("reads the memo with the session's own token and user", async () => {
    cachedRegions.mockResolvedValue([OREGON]);

    await expect(deployRegions("p1")).resolves.toEqual([OREGON]);
    expect(cachedRegions).toHaveBeenCalledWith("token", "u1", "p1");
  });

  /*
   * The contract managedNames carries word for word: this crosses into a client component as
   * an unawaited promise, and a rejected one surfaces there as an error in the client tree
   * rather than as a choice that quietly did not appear.
   */
  it("cannot reject, and answers with the designed empty list instead", async () => {
    cachedRegions.mockRejectedValue(new Error("Railway said no"));

    await expect(deployRegions("p1")).resolves.toEqual([]);
  });

  it("logs a failure at debug, because it runs on every render", async () => {
    cachedRegions.mockRejectedValue(new Error("Railway said no"));

    await deployRegions("p1");

    const line = logRecords().find(
      (record) => record.msg === "dashboard.regions_failed",
    );
    expect(line?.level).toBe("debug");
  });

  it("answers with nothing when there is no session, rather than reading anything", async () => {
    getSession.mockResolvedValue(null);

    await expect(deployRegions("p1")).resolves.toEqual([]);
    expect(cachedRegions).not.toHaveBeenCalled();
  });
});
