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

const { loadDashboard } = await import("./data");
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

describe("loadDashboard", () => {
  it("returns null without a session, leaving the redirect to routing", async () => {
    getSession.mockResolvedValue(null);
    expect(await loadDashboard({})).toBeNull();
  });

  it("defaults to the first project and its first environment", async () => {
    const data = await loadDashboard({});

    expect(data?.project?.id).toBe("p1");
    expect(data?.environment?.id).toBe("e1");
    expect(getProjectContainers).toHaveBeenCalledWith("token", "p1", "e1");
  });

  it("honours an explicit selection", async () => {
    await loadDashboard({ projectId: "p2", environmentId: "e3" });
    expect(getProjectContainers).toHaveBeenCalledWith("token", "p2", "e3");
  });

  it("falls back when the selection names something that no longer exists", async () => {
    // A stale bookmark must not blank the dashboard.
    const data = await loadDashboard({ projectId: "gone", environmentId: "gone" });
    expect(data?.project?.id).toBe("p1");
    expect(data?.environment?.id).toBe("e1");
  });

  it("degrades to an explanation when the project list fails", async () => {
    // A Railway outage should render the shell with a reason, not an error boundary.
    listProjects.mockRejectedValue(
      new RailwayApiError("Rate limited by Railway", { kind: "rate_limit" }),
    );

    const data = await loadDashboard({});

    expect(data?.error).toContain("rate limit");
    expect(data?.projects).toEqual([]);
    expect(getProjectContainers).not.toHaveBeenCalled();
  });

  it("keeps the project selection when only the container query fails", async () => {
    getProjectContainers.mockRejectedValue(
      new RailwayApiError("boom", { kind: "server" }),
    );

    const data = await loadDashboard({});

    expect(data?.project?.id).toBe("p1");
    expect(data?.containers).toEqual([]);
    expect(data?.error).toContain("server error");
  });

  it("uses a generic message for a non-Railway failure", async () => {
    listProjects.mockRejectedValue(new Error("socket hang up"));

    const data = await loadDashboard({});

    expect(data?.error).toBe("Could not load your Railway projects.");
    expect(data?.error).not.toContain("socket");
  });

  it("handles a user with no projects shared", async () => {
    listProjects.mockResolvedValue({ viewer: {}, projects: [] });

    const data = await loadDashboard({});

    expect(data?.projects).toEqual([]);
    expect(data?.project).toBeNull();
    expect(data?.environment).toBeNull();
    expect(data?.error).toBeNull();
  });

  it("handles a project with no environments", async () => {
    listProjects.mockResolvedValue({
      viewer: {},
      projects: [{ id: "p9", name: "Empty", environments: [] }],
    });

    const data = await loadDashboard({});

    expect(data?.project?.id).toBe("p9");
    expect(data?.environment).toBeNull();
    expect(getProjectContainers).not.toHaveBeenCalled();
  });

  it("carries the signed-in identity for the header", async () => {
    const data = await loadDashboard({});
    expect(data?.user).toEqual({ name: "Ada", email: "ada@example.com" });
  });
});
