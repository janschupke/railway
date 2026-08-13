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

  it("sets a database's credentials from the image, not from the request", async () => {
    /*
     * The security property behind the shared preset catalog: variables are derived
     * server-side from the submitted *image string*. The browser never sends a preset id
     * and never sends variables, so there is no request shape in which a caller can
     * inject arbitrary environment into a service — the whole surface is the image
     * reference, which IMAGE_PATTERN already bounds.
     */
    const upserted: Array<Record<string, unknown>> = [];
    server.use(
      api.query("Project", () => HttpResponse.json({ data: projectWith([]) })),
      api.mutation("ServiceCreate", () =>
        HttpResponse.json({
          data: { serviceCreate: { id: "svc_db", name: "spun-cache" } },
        }),
      ),
      api.mutation("VariableCollectionUpsert", ({ variables }) => {
        upserted.push(variables);
        return HttpResponse.json({ data: { variableCollectionUpsert: 1 } });
      }),
      api.mutation("ServiceInstanceDeployV2", () =>
        HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_db" } }),
      ),
    );

    // A tag the catalog does not list: postgres is postgres, and it still needs this.
    const result = await spinUp(null, spinUpForm({ image: "postgres:17" }));

    expect(result).toMatchObject({ ok: true });
    const sent = (upserted[0]?.input as { variables: Record<string, string> })
      .variables;
    expect(Object.keys(sent)).toEqual(["POSTGRES_PASSWORD"]);
    expect(sent.POSTGRES_PASSWORD!.length).toBeGreaterThanOrEqual(32);
  });

  it("sends no variables for an image that boots bare", async () => {
    server.use(
      api.query("Project", () => HttpResponse.json({ data: projectWith([]) })),
      api.mutation("ServiceCreate", () =>
        HttpResponse.json({ data: { serviceCreate: { id: "s", name: "spun-cache" } } }),
      ),
      api.mutation("VariableCollectionUpsert", () => {
        throw new Error("no variables should be sent for a bare image");
      }),
      api.mutation("ServiceInstanceDeployV2", () =>
        HttpResponse.json({ data: { serviceInstanceDeployV2: "d" } }),
      ),
    );

    await expect(
      spinUp(null, spinUpForm({ image: "ghcr.io/owner/app:1.0.0" })),
    ).resolves.toMatchObject({ ok: true });
  });

  it("says a service was created when only its environment failed", async () => {
    // Reporting a bare failure would leave the user hunting for something they were
    // never told had been created.
    server.use(
      api.query("Project", () => HttpResponse.json({ data: projectWith([]) })),
      api.mutation("ServiceCreate", () =>
        HttpResponse.json({ data: { serviceCreate: { id: "s", name: "spun-cache" } } }),
      ),
      api.mutation("VariableCollectionUpsert", () =>
        HttpResponse.json({ errors: [{ message: "Not Authorized" }] }),
      ),
      api.mutation("ServiceInstanceDeployV2", () => {
        throw new Error("must not deploy an unconfigured service");
      }),
    );

    const result = await spinUp(null, spinUpForm({ image: "postgres:16-alpine" }));

    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? "" : result.error).toMatch(/Created cache/);
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
      // Typographic quotes come from the catalog: quoting style differs by locale, so
      // it belongs inside the message rather than around the placeholder.
      error: "A container named \u201Ccache\u201D already exists here.",
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

  it("shows real copy when a field is missing from the form entirely", async () => {
    /*
     * The defect this exists for: formData.get returns null for a field the browser
     * never sent, null fails zod's implicit string check BEFORE the .min(1) that
     * carries the catalog key, and the action then handed zod's own English to the
     * translator as a key. next-intl echoes an unknown key back verbatim, so the toast
     * read "Invalid input: expected string, received null".
     */
    const data = new FormData();
    data.append("projectId", "p1");
    data.append("environmentId", "e1");
    data.append("image", "redis:7-alpine");
    // `name` deliberately absent.

    const result = await spinUp(null, data);

    expect(result).toMatchObject({ ok: false, field: "name" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("Give the container a name");
    expect(result.error).not.toMatch(/Invalid input/);
  });

  it("refuses a reference Railway could not have issued, before any network call", async () => {
    // No MSW handler is registered: a request here would fail the suite. Previously
    // these fields were .min(1) only, so this reached a full project query.
    const result = await spinUp(null, spinUpForm({ projectId: "p1/../admin" }));

    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.error).toBe(
      "That reference is not one Railway could have issued. Reload the page and try again.",
    );
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
    expect(result).toMatchObject({
      ok: false,
      // Railway's own text is not repeated to the user; the reference points at the
      // log line that has it verbatim.
      error: expect.stringMatching(
        /^Railway refused this operation .* Reference [0-9a-f]{8}\.$/,
      ),
    });
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

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(
        /^Something went wrong\. Please try again\. Reference [0-9a-f]{8}\.$/,
      ),
    });
    expect(!result.ok && result.error).not.toContain("ECONNREFUSED");
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

  it("refuses an owned service posted against another environment", async () => {
    /*
     * Ownership is derived per environment — a service with no instance in the one
     * submitted does not appear in the list at all — while `serviceDelete` removes the
     * service from every environment at once. The check is therefore narrower than the
     * effect, and this is the case where that shows: `svc_managed` is genuinely ours,
     * but posted against `e2` it is unknown, and the action refuses rather than
     * reaching for the wider delete.
     */
    let deleteCalls = 0;
    server.use(
      api.query("Project", () => HttpResponse.json({ data: projectWith() })),
      api.mutation("ServiceDelete", () => {
        deleteCalls += 1;
        return HttpResponse.json({ data: { serviceDelete: true } });
      }),
    );

    const result = await spinDown(
      null,
      form({ projectId: "p1", environmentId: "e2", serviceId: "svc_managed" }),
    );

    expect(result).toEqual({ ok: false, error: "That container no longer exists." });
    expect(deleteCalls).toBe(0);
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
    // A rejected credential, not a missing permission: the fix is signing in, and the
    // copy has to say so rather than sending the user to pick projects again.
    expect(!result.ok && result.error).toMatch(/signing in again/i);
  });

  it("propagates a delete failure as a readable message", async () => {
    server.use(
      api.query("Project", () => HttpResponse.json({ data: projectWith() })),
      api.mutation("ServiceDelete", () =>
        HttpResponse.json({ errors: [{ message: "Service is locked" }] }),
      ),
    );

    const result = await spinDown(null, downForm("svc_managed"));
    expect(result).toMatchObject({
      ok: false,
      // "Service is locked" names Railway's internal state; the user gets a reference
      // and the operator greps the log for it.
      error: expect.stringMatching(
        /^Railway refused this operation .* Reference [0-9a-f]{8}\.$/,
      ),
    });
  });
});

describe("error mapping", () => {
  it("keeps RailwayApiError's user-facing descriptor free of its internal message", () => {
    const error = new RailwayApiError("HTTP 429 from backboard", {
      kind: "rate_limit",
      retryAfterSeconds: 30,
    });

    const descriptor = error.describe();
    expect(descriptor).toEqual({
      key: "errors.api.rateLimitRetry",
      // The id travels with every descriptor now: it was already being written to the
      // log for these kinds, and a sentence that cannot name it points at nothing.
      values: { seconds: 30, incident: error.incidentId },
    });
    // The upstream text names an internal host; it must not travel with the message.
    expect(JSON.stringify(descriptor)).not.toContain("backboard");
  });
});
