import { NextRequest } from "next/server";
import { HttpResponse, graphql } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { railwayApiUrl } from "@/lib/railway/client";
import { logRecords, rawLogLines } from "@/test/log-capture";

const session = {
  user: { id: "u1", name: "Ada", email: "ada@example.com" },
  accessToken: "token",
  refreshToken: "refresh",
  expiresAt: 9_999_999_999,
  scope: "openid project:admin",
};
const requireSession = vi.fn(async () => session);
vi.mock("@/lib/auth/server", () => ({
  requireSession: () => requireSession(),
  requireAccessToken: async () => (await requireSession()).accessToken,
}));

/*
 * Driven through MSW rather than by mocking `listServiceDeployments`, for the reason the
 * variables route's own file gives: the properties under test are the input this endpoint
 * scopes the read with and the degradation when Railway refuses it, and a mocked reader
 * would be a test of a stub returning a list.
 */
const { GET } = await import("./route");

const api = graphql.link(railwayApiUrl());
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

beforeEach(() => {
  requireSession.mockReset().mockResolvedValue(session);
});

const request = (params: Record<string, string> = {}) => {
  const url = new URL("/api/service-deployments", "http://localhost:3000");
  const defaults = { project: "p1", environment: "e1", service: "svc_1" };
  for (const [key, value] of Object.entries({ ...defaults, ...params })) {
    if (value !== "") url.searchParams.set(key, value);
  }
  return new NextRequest(url);
};

/** One node of the connection, with only the members the document selects. */
const dep = (
  id: string,
  createdAt: string,
  { status = "SUCCESS", canRollback = true } = {},
) => ({ node: { id, status, createdAt, canRollback } });

const deployments = (edges: ReturnType<typeof dep>[]) =>
  api.query("Deployments", () =>
    HttpResponse.json({ data: { deployments: { edges } } }),
  );

describe("GET /api/service-deployments", () => {
  it("answers with the service's deployments, newest first", async () => {
    server.use(
      deployments([
        dep("dep_old", "2026-08-15T09:00:00.000Z", { canRollback: true }),
        dep("dep_new", "2026-08-15T11:00:00.000Z", { canRollback: false }),
      ]),
    );

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      refused: false,
      deployments: [
        {
          id: "dep_new",
          state: "running",
          rawStatus: "SUCCESS",
          createdAt: "2026-08-15T11:00:00.000Z",
          canRollback: false,
        },
        {
          id: "dep_old",
          state: "running",
          rawStatus: "SUCCESS",
          createdAt: "2026-08-15T09:00:00.000Z",
          canRollback: true,
        },
      ],
    });
  });

  it("scopes the read to the service that was asked about", async () => {
    let input: unknown;
    server.use(
      api.query("Deployments", ({ variables }) => {
        input = variables.input;
        return HttpResponse.json({ data: { deployments: { edges: [] } } });
      }),
    );

    await GET(request({ service: "svc_other" }));

    expect(input).toMatchObject({ serviceId: "svc_other" });
  });

  it("does not cache a list that changes with every deploy", async () => {
    server.use(deployments([]));

    const response = await GET(request());

    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("distinguishes a refused read from a service that has never deployed", async () => {
    /*
     * Both are an empty list, and the panel has a different sentence for each — so the flag
     * has to travel. Collapsing them told anyone whose token cannot make this read that
     * their service had never deployed.
     *
     * Still a 200: `Deployments` is in DEGRADING_OPERATIONS and the request itself
     * succeeded. This endpoint answers what the app was able to learn, and "nothing, because
     * Railway said no" is an answer rather than a failure of the route.
     */
    server.use(
      api.query("Deployments", () =>
        HttpResponse.json({
          data: null,
          errors: [{ message: "Not Authorized", path: ["deployments"] }],
        }),
      ),
    );

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deployments: [], refused: true });
  });

  it("reports a genuinely empty history as answered", async () => {
    server.use(deployments([]));

    const response = await GET(request());

    expect(await response.json()).toEqual({ deployments: [], refused: false });
  });

  it("refuses a malformed id before reading the session", async () => {
    // Cheapest refusal first, and nothing reaches Railway: `onUnhandledRequest: "error"`
    // means any request here would fail the test.
    const response = await GET(request({ service: "not/an/id" }));

    expect(response.status).toBe(400);
    expect(requireSession).not.toHaveBeenCalled();
    expect(
      logRecords().find((r) => r.msg === "deployments.read_rejected"),
    ).toMatchObject({ reason: "invalid_id" });
  });

  it("refuses a missing id", async () => {
    const response = await GET(request({ environment: "" }));

    expect(response.status).toBe(400);
  });

  it("logs no id it was handed on the URL", async () => {
    await GET(request({ service: "../../etc/passwd" }));

    expect(rawLogLines().join("\n")).not.toContain("etc/passwd");
  });

  it("refuses an unauthenticated caller", async () => {
    requireSession.mockRejectedValue(new Error("no session"));

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(
      logRecords().find((r) => r.msg === "deployments.read_rejected"),
    ).toMatchObject({ reason: "unauthenticated" });
  });

  it("records a count rather than the ids it returned", async () => {
    server.use(
      deployments([
        dep("dep_a", "2026-08-15T09:00:00.000Z"),
        dep("dep_b", "2026-08-15T10:00:00.000Z"),
      ]),
    );

    await GET(request());

    expect(logRecords().find((r) => r.msg === "deployments.read")).toMatchObject({
      service_id: "svc_1",
      deployment_count: 2,
    });
    // The one question this record answers is whether the panel got a history to choose
    // from, and the number answers it.
    expect(rawLogLines().join("\n")).not.toContain("dep_a");
  });
});
