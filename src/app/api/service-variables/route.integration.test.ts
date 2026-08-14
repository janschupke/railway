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
 * Driven through MSW rather than by mocking `readServiceVariableNames`, and that is the
 * point of this file: the property under test is that **no value survives the trip**, and a
 * mocked reader would be a test of a stub that returns names. The real document, the real
 * filter and the real response are all in the path here.
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
  const url = new URL("/api/service-variables", "http://localhost:3000");
  const defaults = { project: "p1", environment: "e1", service: "svc_1" };
  for (const [key, value] of Object.entries({ ...defaults, ...params })) {
    if (value !== "") url.searchParams.set(key, value);
  }
  return new NextRequest(url);
};

const variables = (
  service: Record<string, string>,
  shared: Record<string, string> = {},
) =>
  api.query("ServiceVariables", () => HttpResponse.json({ data: { service, shared } }));

describe("GET /api/service-variables", () => {
  it("answers with names and no values", async () => {
    /*
     * The whole reason this endpoint exists in the shape it does. The edit form needs to
     * know which rows to draw; a response that carried the values would put a generated
     * database password in the browser and break the e2e assertion that no minted credential
     * ever appears in the page.
     */
    server.use(variables({ POSTGRES_PASSWORD: "hunter2", PORT: "5432" }));

    const response = await GET(request());
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(body)).toEqual({ names: ["PORT", "POSTGRES_PASSWORD"] });
    expect(body).not.toContain("hunter2");
    expect(body).not.toContain("5432");
  });

  it("does not cache an answer that changes with every save", async () => {
    server.use(variables({ A: "1" }));

    const response = await GET(request());

    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses a malformed id before reading the session", async () => {
    // Cheapest refusal first, and nothing reaches Railway: `onUnhandledRequest: "error"`
    // means any request here would fail the test.
    const response = await GET(request({ service: "not/an/id" }));

    expect(response.status).toBe(400);
    expect(requireSession).not.toHaveBeenCalled();
    expect(logRecords().find((r) => r.msg === "variables.read_rejected")).toMatchObject(
      {
        reason: "invalid_id",
      },
    );
  });

  it("refuses a missing id", async () => {
    const response = await GET(request({ environment: "" }));

    expect(response.status).toBe(400);
  });

  it("logs no id it was handed on the URL", async () => {
    /*
     * The three ids arrive unbounded and caller-chosen, which is the same call the stream
     * route makes about a rejected deploymentId — a field an operator greps must not be
     * something a caller writes.
     */
    await GET(request({ service: "../../etc/passwd" }));

    expect(rawLogLines().join("\n")).not.toContain("etc/passwd");
  });

  it("refuses an unauthenticated caller", async () => {
    requireSession.mockRejectedValue(new Error("no session"));

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(logRecords().find((r) => r.msg === "variables.read_rejected")).toMatchObject(
      {
        reason: "unauthenticated",
      },
    );
  });

  it("records a count rather than the names it returned", async () => {
    server.use(variables({ ALPHA: "1", BETA: "2" }));

    await GET(request());

    expect(logRecords().find((r) => r.msg === "variables.read")).toMatchObject({
      service_id: "svc_1",
      variable_count: 2,
    });
    // Once a person can type a name, the set stops being closed and stops being loggable.
    expect(rawLogLines().join("\n")).not.toContain("ALPHA");
  });
});
