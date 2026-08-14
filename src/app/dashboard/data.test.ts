import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RailwaySession } from "@/lib/auth/session";

const getSession = vi.fn<() => Promise<RailwaySession | null>>();
const listProjects = vi.fn();
const getProjectContainers = vi.fn();
const getProjectMetrics = vi.fn();

vi.mock("@/lib/auth/server", () => ({ getSession: () => getSession() }));
vi.mock("@/lib/railway/api", () => ({
  listProjects: (...args: unknown[]) => listProjects(...args),
  getProjectContainers: (...args: unknown[]) => getProjectContainers(...args),
  getProjectMetrics: (...args: unknown[]) => getProjectMetrics(...args),
}));

const { loadDashboardShell, loadContainers, managedNames } = await import("./data");
const { RailwayApiError } = await import("@/lib/railway/errors");
const { __resetEnv } = await import("@/env");

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

beforeEach(() => {
  getSession.mockReset().mockResolvedValue(session);
  listProjects.mockReset().mockResolvedValue({ viewer: {}, projects, failures: [] });
  getProjectMetrics.mockReset().mockResolvedValue({ metrics: {}, spend: null });
  getProjectContainers
    .mockReset()
    .mockResolvedValue({ project: projects[0], containers: [] });
});

describe("loadDashboardShell", () => {
  it("returns null without a session, leaving the redirect to routing", async () => {
    getSession.mockResolvedValue(null);
    expect(await loadDashboardShell({})).toBeNull();
  });

  it("never reads containers", async () => {
    /*
     * The load-bearing property of the split: the shell is what the user waits for
     * before anything renders, so a second Railway round trip must not be in it. Fails
     * the moment someone re-inlines the container read for convenience.
     */
    await loadDashboardShell({});
    expect(getProjectContainers).not.toHaveBeenCalled();
  });

  it("defaults to the first project and its first environment", async () => {
    const shell = await loadDashboardShell({});

    expect(shell?.project?.id).toBe("p1");
    expect(shell?.environment?.id).toBe("e1");
  });

  it("honours an explicit selection", async () => {
    const shell = await loadDashboardShell({ projectId: "p2", environmentId: "e3" });

    expect(shell?.project?.id).toBe("p2");
    expect(shell?.environment?.id).toBe("e3");
  });

  it("falls back when the selection names something that no longer exists", async () => {
    // A stale bookmark must not blank the dashboard.
    const shell = await loadDashboardShell({
      projectId: "gone",
      environmentId: "gone",
    });
    expect(shell?.project?.id).toBe("p1");
    expect(shell?.environment?.id).toBe("e1");
  });

  it("reports a substituted project rather than swapping it silently", async () => {
    // Showing another project's containers under a link that names a specific one is
    // the kind of quiet wrong answer a user cannot detect.
    const shell = await loadDashboardShell({ projectId: "gone" });
    expect(shell?.droppedSelection).toBe(true);
  });

  it("does not call an unknown environment a substitution", async () => {
    // The project asked for is the one shown; its default environment is not a swap.
    const shell = await loadDashboardShell({ projectId: "p1", environmentId: "gone" });

    expect(shell?.droppedSelection).toBe(false);
    expect(shell?.environment?.id).toBe("e1");
  });

  it("does not report a substitution when there was nothing to substitute", async () => {
    listProjects.mockResolvedValue({ viewer: {}, projects: [], failures: [] });

    const shell = await loadDashboardShell({ projectId: "gone" });

    expect(shell?.droppedSelection).toBe(false);
  });

  it("names the scopes Railway withheld, so the page can say why the list is empty", async () => {
    // An empty list caused by a denied scope needs the opposite advice from an empty
    // list that is simply empty — this is what lets the page tell them apart.
    getSession.mockResolvedValue({ ...session, scope: "openid email" });

    const shell = await loadDashboardShell({});

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

    expect((await loadDashboardShell({}))?.missingScopes).toEqual([]);
  });

  it("degrades to an explanation when the project list fails", async () => {
    // A Railway outage should render the shell with a reason, not an error boundary.
    listProjects.mockRejectedValue(
      new RailwayApiError("Rate limited by Railway", { kind: "rate_limit" }),
    );

    const shell = await loadDashboardShell({});

    expect(shell?.error).toContain("rate limit");
    expect(shell?.projects).toEqual([]);
    // The kind is what lets the page offer a retry here and re-consent on an auth
    // failure, instead of showing both every time.
    expect(shell?.errorKind).toBe("rate_limit");
  });

  it("leaves the failure kind unset for a non-Railway error", async () => {
    listProjects.mockRejectedValue(new Error("socket hang up"));
    expect((await loadDashboardShell({}))?.errorKind).toBeNull();
  });

  it("uses a generic message for a non-Railway failure", async () => {
    listProjects.mockRejectedValue(new Error("socket hang up"));

    const shell = await loadDashboardShell({});

    expect(shell?.error).toMatch(
      /^Could not load your Railway projects\. Reference \w+\.$/,
    );
    expect(shell?.error).not.toContain("socket");
  });

  it("handles a user with no projects shared", async () => {
    listProjects.mockResolvedValue({ viewer: {}, projects: [], failures: [] });

    const shell = await loadDashboardShell({});

    expect(shell?.projects).toEqual([]);
    expect(shell?.project).toBeNull();
    expect(shell?.environment).toBeNull();
    expect(shell?.error).toBeNull();
  });

  it("handles a project with no environments", async () => {
    listProjects.mockResolvedValue({
      viewer: {},
      projects: [{ id: "p9", name: "Empty", environments: [] }],
      failures: [],
    });

    const shell = await loadDashboardShell({});

    expect(shell?.project?.id).toBe("p9");
    expect(shell?.environment).toBeNull();
  });

  it("carries the signed-in identity for the header", async () => {
    const shell = await loadDashboardShell({});
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

    expect(data).toEqual({ containers: [], error: null, metrics: {}, spend: null });
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
      process.env.METRICS_POLL_MS = "0";
      __resetEnv();
      try {
        getProjectContainers.mockResolvedValue({
          project: projects[0],
          containers: [{ serviceId: "s1" }],
        });

        const data = await loadContainers("p1", "e1");

        expect(getProjectMetrics).not.toHaveBeenCalled();
        expect(data.metrics).toEqual({});
        expect(data.spend).toBeNull();
      } finally {
        delete process.env.METRICS_POLL_MS;
        __resetEnv();
      }
    });
  });
});
