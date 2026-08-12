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

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

const requireAccessToken = vi.fn(async () => "token");
vi.mock("@/lib/auth/server", () => ({
  requireAccessToken: () => requireAccessToken(),
}));

const { spinUp, spinDown } = await import("./actions");
const { SessionExpiredError } = await import("@/lib/auth/refresh");
const { RailwayApiError } = await import("@/lib/railway/errors");

const api = graphql.link(railwayApiUrl());
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** One project, one environment, one managed service and one that this app did not create. */
function projectWith(
  services: Array<{ id: string; name: string }> = [
    { id: "svc_managed", name: "spun-cache" },
    { id: "svc_foreign", name: "postgres" },
  ],
) {
  return {
    project: {
      id: "p1",
      name: "Demo",
      environments: { edges: [{ node: { id: "e1", name: "production" } }] },
      services: {
        edges: services.map((s) => ({
          node: {
            id: s.id,
            name: s.name,
            createdAt: "2026-08-01T00:00:00Z",
            serviceInstances: {
              edges: [
                {
                  node: {
                    id: `si_${s.id}`,
                    environmentId: "e1",
                    source: { image: "redis:7-alpine", repo: null },
                    latestDeployment: {
                      id: `dep_${s.id}`,
                      status: "SUCCESS",
                      createdAt: "2026-08-01T00:00:00Z",
                      updatedAt: "2026-08-01T00:00:00Z",
                    },
                  },
                },
              ],
            },
          },
        })),
      },
    },
  };
}

const form = (entries: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.append(key, value);
  return data;
};

const spinUpForm = (over: Record<string, string> = {}) =>
  form({
    projectId: "p1",
    environmentId: "e1",
    name: "cache",
    image: "redis:7-alpine",
    ...over,
  });

beforeEach(() => {
  revalidatePath.mockClear();
  requireAccessToken.mockReset();
  requireAccessToken.mockResolvedValue("token");
});

describe("spinUp", () => {
  it("creates and deploys a prefixed service", async () => {
    const created: Array<Record<string, unknown>> = [];
    const deployed: Array<Record<string, unknown>> = [];

    server.use(
      api.query("Project", () => HttpResponse.json({ data: projectWith([]) })),
      api.mutation("ServiceCreate", ({ variables }) => {
        created.push(variables);
        return HttpResponse.json({
          data: { serviceCreate: { id: "svc_new", name: "spun-cache" } },
        });
      }),
      api.mutation("ServiceInstanceDeployV2", ({ variables }) => {
        deployed.push(variables);
        return HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_new" } });
      }),
    );

    const result = await spinUp(null, spinUpForm());

    expect(result).toEqual({ ok: true, message: "Spinning up cache" });
    // The ownership prefix is applied at creation — it is what makes destroy possible.
    expect(created[0]?.input).toMatchObject({
      projectId: "p1",
      environmentId: "e1",
      name: "spun-cache",
      source: { image: "redis:7-alpine" },
    });
    expect(deployed[0]).toMatchObject({ serviceId: "svc_new", environmentId: "e1" });
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard");
  });

  it("refuses a duplicate name without calling Railway", async () => {
    let createCalls = 0;
    server.use(
      api.query("Project", () => HttpResponse.json({ data: projectWith() })),
      api.mutation("ServiceCreate", () => {
        createCalls += 1;
        return HttpResponse.json({ data: { serviceCreate: { id: "x", name: "x" } } });
      }),
    );

    const result = await spinUp(null, spinUpForm());

    expect(result).toEqual({
      ok: false,
      field: "name",
      error: 'A container named "cache" already exists here.',
    });
    expect(createCalls).toBe(0);
  });

  it("rejects a malformed image before any network call", async () => {
    // No MSW handler is registered: any request would fail the suite.
    const result = await spinUp(null, spinUpForm({ image: "redis; rm -rf /" }));

    expect(result).toMatchObject({ ok: false, field: "image" });
  });

  it("rejects an empty name", async () => {
    const result = await spinUp(null, spinUpForm({ name: "   " }));
    expect(result).toEqual({
      ok: false,
      field: "name",
      error: "Give the container a name",
    });
  });

  it("reports a missing project reference without attributing it to a field", async () => {
    const result = await spinUp(null, spinUpForm({ projectId: "" }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.field).toBeUndefined();
  });

  it("surfaces a Railway rate limit in the user's language", async () => {
    server.use(
      api.query("Project", () => HttpResponse.json({ data: projectWith([]) })),
      api.mutation("ServiceCreate", () =>
        HttpResponse.json(
          { errors: [{ message: "Too many requests" }] },
          { status: 200 },
        ),
      ),
    );

    const result = await spinUp(null, spinUpForm());
    expect(result).toEqual({ ok: false, error: "Too many requests" });
  });

  it("asks the user to sign in again when the session cannot be refreshed", async () => {
    requireAccessToken.mockRejectedValue(new SessionExpiredError());

    const result = await spinUp(null, spinUpForm());

    expect(result).toEqual({
      ok: false,
      error: "Your Railway session expired. Sign in again.",
    });
  });

  it("does not leak an unexpected internal error", async () => {
    requireAccessToken.mockRejectedValue(new Error("ECONNREFUSED 10.0.0.1"));

    const result = await spinUp(null, spinUpForm());

    expect(result).toEqual({
      ok: false,
      error: "Something went wrong. Please try again.",
    });
  });
});

describe("spinDown", () => {
  const downForm = (serviceId: string) =>
    form({ projectId: "p1", environmentId: "e1", serviceId });

  it("destroys a service this app created", async () => {
    const deleted: string[] = [];
    server.use(
      api.query("Project", () => HttpResponse.json({ data: projectWith() })),
      api.mutation("ServiceDelete", ({ variables }) => {
        deleted.push(variables.id as string);
        return HttpResponse.json({ data: { serviceDelete: true } });
      }),
    );

    const result = await spinDown(null, downForm("svc_managed"));

    expect(result).toEqual({ ok: true, message: "Destroyed cache" });
    expect(deleted).toEqual(["svc_managed"]);
  });

  it("refuses to destroy a service it did not create", async () => {
    /*
     * The load-bearing safety test. The user's own token would happily delete this
     * service; the refusal is ours, derived server-side, and cannot be bypassed by
     * posting a different serviceId from the client.
     */
    let deleteCalls = 0;
    server.use(
      api.query("Project", () => HttpResponse.json({ data: projectWith() })),
      api.mutation("ServiceDelete", () => {
        deleteCalls += 1;
        return HttpResponse.json({ data: { serviceDelete: true } });
      }),
    );

    const result = await spinDown(null, downForm("svc_foreign"));

    expect(result).toEqual({
      ok: false,
      error: "This service was not created here, so it cannot be destroyed here.",
    });
    expect(deleteCalls).toBe(0);
  });

  it("reports a service that has already gone and refreshes the list", async () => {
    server.use(api.query("Project", () => HttpResponse.json({ data: projectWith() })));

    const result = await spinDown(null, downForm("svc_missing"));

    expect(result).toEqual({ ok: false, error: "That container no longer exists." });
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard");
  });

  it("rejects a request with no service reference", async () => {
    const result = await spinDown(null, form({ projectId: "p1" }));
    expect(result).toEqual({ ok: false, error: "Missing container reference." });
  });

  it("maps a revoked authorization to a re-consent message", async () => {
    server.use(
      api.query("Project", () =>
        HttpResponse.json(
          { errors: [{ message: "nope", extensions: { code: "UNAUTHENTICATED" } }] },
          { status: 200 },
        ),
      ),
    );

    const result = await spinDown(null, downForm("svc_managed"));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("sign in again");
  });

  it("propagates a delete failure as a readable message", async () => {
    server.use(
      api.query("Project", () => HttpResponse.json({ data: projectWith() })),
      api.mutation("ServiceDelete", () =>
        HttpResponse.json({ errors: [{ message: "Service is locked" }] }),
      ),
    );

    const result = await spinDown(null, downForm("svc_managed"));
    expect(result).toEqual({ ok: false, error: "Service is locked" });
  });
});

describe("error mapping", () => {
  it("keeps RailwayApiError's user message distinct from its internal one", () => {
    const error = new RailwayApiError("HTTP 429 from backboard", {
      kind: "rate_limit",
      retryAfterSeconds: 30,
    });
    expect(error.userMessage()).toContain("30s");
    expect(error.userMessage()).not.toContain("backboard");
  });
});
