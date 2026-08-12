import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RailwaySession } from "@/lib/auth/session";

const getSession = vi.fn<() => Promise<RailwaySession | null>>();
const listProjects = vi.fn();
const getProjectContainers = vi.fn();

vi.mock("@/lib/auth/server", () => ({ getSession: () => getSession() }));
vi.mock("@/lib/railway/api", () => ({
  listProjects: (...args: unknown[]) => listProjects(...args),
  getProjectContainers: (...args: unknown[]) => getProjectContainers(...args),
}));

const { loadDashboardShell, loadContainers } = await import("./data");
const { RailwayApiError } = await import("@/lib/railway/errors");

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
  listProjects.mockReset().mockResolvedValue({ viewer: {}, projects });
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

  it("degrades to an explanation when the project list fails", async () => {
    // A Railway outage should render the shell with a reason, not an error boundary.
    listProjects.mockRejectedValue(
      new RailwayApiError("Rate limited by Railway", { kind: "rate_limit" }),
    );

    const shell = await loadDashboardShell({});

    expect(shell?.error).toContain("rate limit");
    expect(shell?.projects).toEqual([]);
  });

  it("uses a generic message for a non-Railway failure", async () => {
    listProjects.mockRejectedValue(new Error("socket hang up"));

    const shell = await loadDashboardShell({});

    expect(shell?.error).toBe("Could not load your Railway projects.");
    expect(shell?.error).not.toContain("socket");
  });

  it("handles a user with no projects shared", async () => {
    listProjects.mockResolvedValue({ viewer: {}, projects: [] });

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

    expect(data.error).toBe("Could not load containers for this environment.");
    expect(data.error).not.toContain("socket");
  });

  it("is inert without a session", async () => {
    // The shell already redirected; this is a guard, not a path.
    getSession.mockResolvedValue(null);

    const data = await loadContainers("p1", "e1");

    expect(data).toEqual({ containers: [], error: null });
    expect(getProjectContainers).not.toHaveBeenCalled();
  });
});
