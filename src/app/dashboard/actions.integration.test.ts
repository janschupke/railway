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

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

const requireAccessToken = vi.fn(async () => "token");
/*
 * `spinUp` reads the whole session rather than the token alone: the idempotency key it
 * is handed is client-supplied, so the entry it claims has to be namespaced by who
 * claimed it. The two mocks must agree — a case that rejects one and not the other is
 * asserting against a session state production cannot be in.
 */
const requireSession = vi.fn(async () => ({
  user: { id: "u1" },
  accessToken: "token",
}));
vi.mock("@/lib/auth/server", () => ({
  requireAccessToken: () => requireAccessToken(),
  requireSession: () => requireSession(),
}));

const { spinUp, spinDown, createProject, createEnvironment } =
  await import("./actions");
const { __resetIdempotency } = await import("@/lib/idempotency");
const { newIdempotencyKey } = await import("@/lib/random-id");
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

/*
 * A fresh key per call, before the spread so a case can pin one deliberately.
 *
 * Fresh matters: a shared constant would make every case in this file a replay of the
 * previous one's result, which is exactly the behaviour under test and would hide it
 * everywhere else.
 */
const spinUpForm = (over: Record<string, string> = {}) =>
  form({
    projectId: "p1",
    environmentId: "e1",
    name: "cache",
    image: "redis:7-alpine",
    idempotencyKey: newIdempotencyKey(),
    ...over,
  });

/**
 * The spin-up form with environment rows on it, as the editor posts them.
 *
 * Two parallel repeated fields rather than one structured value: index i of `variableKey`
 * and index i of `variableValue` are one row, which is the wire format the schema and the
 * row-attributed errors both depend on.
 */
const spinUpFormWith = (
  rows: Array<[string, string]>,
  over: Record<string, string> = {},
) => {
  const data = spinUpForm(over);
  for (const [key, value] of rows) {
    data.append("variableKey", key);
    data.append("variableValue", value);
  }
  return data;
};

/** The one record carrying an event name, so an assertion names the event it means. */
const record = (event: string) => logRecords().find((r) => r.msg === event);

beforeEach(() => {
  revalidatePath.mockClear();
  requireAccessToken.mockReset();
  requireAccessToken.mockResolvedValue("token");
  requireSession.mockReset();
  requireSession.mockResolvedValue({ user: { id: "u1" }, accessToken: "token" });
  // Retained results are process-global and outlive the call that made them, so without
  // this a case would be served a previous case's container.
  __resetIdempotency();
});

describe("spinUp", () => {
  it("creates and deploys a prefixed service", async () => {
    const created: Array<Record<string, unknown>> = [];
    const deployed: Array<Record<string, unknown>> = [];

    server.use(
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

  /**
   * Registers a working create path and collects what reached VariableCollectionUpsert.
   *
   * The array is the assertion surface for every variables test below: it is the only
   * place the environment a service was actually created with can be read, since nothing
   * logs it and nothing returns it.
   */
  function collectingVariables(serviceId = "svc_db") {
    const upserted: Array<Record<string, unknown>> = [];
    server.use(
      api.mutation("ServiceCreate", () =>
        HttpResponse.json({
          data: { serviceCreate: { id: serviceId, name: "spun-cache" } },
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
    const sent = () =>
      (upserted[0]?.input as { variables: Record<string, string> } | undefined)
        ?.variables;
    return { upserted, sent };
  }

  it("mints a database's credential when the row is left blank", async () => {
    const { sent } = collectingVariables();

    // A tag the catalog does not list: postgres is postgres, and it still needs this.
    const result = await spinUp(
      null,
      spinUpFormWith([["POSTGRES_PASSWORD", ""]], { image: "postgres:17" }),
    );

    expect(result).toMatchObject({ ok: true });
    expect(Object.keys(sent()!)).toEqual(["POSTGRES_PASSWORD"]);
    expect(sent()!.POSTGRES_PASSWORD!.length).toBeGreaterThanOrEqual(32);
    // The user has no copy of what was minted, so they are told where to read it.
    expect(result.ok && result.message).toMatch(/generated credentials are on Railway/);
  });

  it("uses the password the user typed instead of minting one", async () => {
    const { sent } = collectingVariables();

    const result = await spinUp(
      null,
      spinUpFormWith([["POSTGRES_PASSWORD", "hunter2hunter2"]], {
        image: "postgres:17",
      }),
    );

    expect(sent()).toEqual({ POSTGRES_PASSWORD: "hunter2hunter2" });
    /*
     * The whole reason resolveVariables reports whether it minted anything. Telling
     * someone who typed their own password to go and read it on Railway is a lie, and it
     * is the kind of lie a boolean on `variables` would have told.
     */
    expect(result).toEqual({ ok: true, message: "Spinning up cache" });
  });

  it("mints only for a name the catalog declares generated", async () => {
    /*
     * The replacement for the property this ticket retired, and the assertion that keeps
     * it honest at this tier.
     *
     * The browser can now name any variable it likes. What it still cannot do is ask for
     * a secret: minting is granted by the catalog, keyed on a name the catalog owns for
     * the submitted image, and taken up by leaving that row blank. A row the catalog does
     * not own is set to the empty string the user actually submitted.
     */
    const { sent } = collectingVariables();

    await spinUp(
      null,
      spinUpFormWith(
        [
          ["NOT_A_PRESET_KEY", ""],
          ["MYSQL_ROOT_PASSWORD", ""],
        ],
        { image: "postgres:17" },
      ),
    );

    expect(sent()).toEqual({ NOT_A_PRESET_KEY: "", MYSQL_ROOT_PASSWORD: "" });
  });

  it("falls back to the catalog when the form carries no variable fields", async () => {
    /*
     * The pre-T-487 request shape, which is still what a form posted without JavaScript
     * sends. Keeping it working is what lets the e2e helper and every older caller stay
     * as they are.
     */
    const { sent } = collectingVariables();

    await spinUp(null, spinUpForm({ image: "postgres:17" }));

    expect(Object.keys(sent()!)).toEqual(["POSTGRES_PASSWORD"]);
    expect(sent()!.POSTGRES_PASSWORD!.length).toBeGreaterThanOrEqual(32);
  });

  it("sets the variables the user typed on an image that boots bare", async () => {
    const { sent } = collectingVariables();

    await spinUp(
      null,
      spinUpFormWith(
        [
          ["GREETING", "hello"],
          ["DEBUG", ""],
        ],
        { image: "ghcr.io/owner/app:1.0.0" },
      ),
    );

    // The blank one is set empty, not minted: nothing in the catalog owns this image.
    expect(sent()).toEqual({ GREETING: "hello", DEBUG: "" });
  });

  it("refuses a name Railway sets itself, without creating anything", async () => {
    /*
     * No ServiceCreate handler is registered, so `onUnhandledRequest: "error"` turns
     * "a mutation was attempted" into a failure for free — which is the half of this that
     * matters. A refused row must not leave a service behind.
     */
    const result = await spinUp(
      null,
      spinUpFormWith([["RAILWAY_TOKEN", "x"]], { image: "redis:7-alpine" }),
    );

    expect(result).toEqual({
      ok: false,
      error: "Names starting with RAILWAY_ are set by Railway itself",
      field: "variableKey",
      index: 0,
    });
  });

  it("attributes a bad row to that row", async () => {
    const result = await spinUp(
      null,
      spinUpFormWith([
        ["FINE", "1"],
        ["ALSO_FINE", "2"],
        ["1bad", "3"],
      ]),
    );

    expect(result).toMatchObject({ ok: false, field: "variableKey", index: 2 });
  });

  it("carries no row index for a rule about the whole list", async () => {
    // The form has no row to attach these to, so they have to reach the user as a toast.
    const result = await spinUp(
      null,
      spinUpFormWith(
        Array.from(
          { length: 26 },
          (_unused, index) => [`V${index}`, ""] as [string, string],
        ),
      ),
    );

    expect(result).toMatchObject({ ok: false, field: "variableKey" });
    expect(result.ok ? undefined : result.index).toBeUndefined();
  });

  it("reports a bad container name ahead of a bad variable row", async () => {
    const result = await spinUp(
      null,
      spinUpFormWith([["1bad", ""]], { name: "x".repeat(41) }),
    );

    expect(result).toMatchObject({ ok: false, field: "name" });
  });

  it("names the preset variables in the audit line, and counts the rest", async () => {
    /*
     * The two halves have different cardinality, so they are recorded differently.
     * Preset names come from a closed catalog and stay a usable label; a user-supplied
     * name is unbounded and attacker-chosen, which is the same reason the rejected
     * deploymentId is not logged.
     */
    collectingVariables();

    await spinUp(
      null,
      spinUpFormWith(
        [
          ["POSTGRES_PASSWORD", ""],
          ["MY_FLAG", "on"],
        ],
        { image: "postgres:17" },
      ),
    );

    expect(record("container.created")).toMatchObject({
      variable_names: "POSTGRES_PASSWORD",
      user_variable_count: 1,
    });
  });

  it("counts rather than names the variables when Railway refuses them", async () => {
    server.use(
      api.mutation("ServiceCreate", () =>
        HttpResponse.json({ data: { serviceCreate: { id: "s", name: "spun-cache" } } }),
      ),
      api.mutation("VariableCollectionUpsert", () =>
        HttpResponse.json({ errors: [{ message: "Not Authorized" }] }),
      ),
    );

    await spinUp(
      null,
      spinUpFormWith(
        [
          ["POSTGRES_PASSWORD", ""],
          ["MY_FLAG", "on"],
        ],
        { image: "postgres:17" },
      ),
    );

    const failed = record("railway.variables_failed");
    expect(failed).toMatchObject({ variable_count: 2 });
    expect(failed).not.toHaveProperty("variable_names");
  });

  it("writes no variable value, and no user-supplied name, to stdout", async () => {
    /*
     * The credential canary the OAuth callback has, for the other credential path.
     *
     * rawLogLines rather than logRecords on purpose: a parsed record cannot see a value
     * that leaked through a message string, an err.stack, or a field added to this line
     * after this test was written. All three halves are asserted — the value the user
     * typed, the value the server minted, and the name the user chose, which T-487 puts
     * on the same footing as the rejected deploymentId.
     */
    const typed = "s3cret-value-nobody-should-see";
    const { sent } = collectingVariables();

    await spinUp(
      null,
      spinUpFormWith(
        [
          ["POSTGRES_PASSWORD", ""],
          ["MY_SECRET_FLAG", typed],
        ],
        { image: "postgres:17" },
      ),
    );

    const minted = sent()!.POSTGRES_PASSWORD!;
    const written = rawLogLines().join("\n");

    expect(minted.length).toBeGreaterThanOrEqual(32);
    expect(written).not.toContain(typed);
    expect(written).not.toContain(minted);
    expect(written).not.toContain("MY_SECRET_FLAG");
  });

  it("sends no variables for an image that boots bare", async () => {
    server.use(
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
    // A service exists, so the audit line ran — and says it is not running.
    expect(record("container.created")).toMatchObject({
      service_id: "s",
      outcome: "variables_failed",
    });
  });

  it("names the service when Railway refuses the deploy", async () => {
    /*
     * The service exists on Railway and is billable. Answering with a generic failure —
     * which is what an uncaught deploy error produced — left the user with an orphan they
     * had never been told the name of, and left the audit trail with no record of it at
     * all: `container.created` was downstream of the throw.
     */
    let generated = "";
    server.use(
      api.mutation("ServiceCreate", () =>
        HttpResponse.json({
          data: { serviceCreate: { id: "svc_orphan", name: "spun-cache" } },
        }),
      ),
      api.mutation("VariableCollectionUpsert", ({ variables }) => {
        const sent = (variables.input as { variables: Record<string, string> })
          .variables;
        generated = sent.POSTGRES_PASSWORD!;
        return HttpResponse.json({ data: { variableCollectionUpsert: 1 } });
      }),
      api.mutation("ServiceInstanceDeployV2", () =>
        HttpResponse.json({ errors: [{ message: "Not Authorized" }] }),
      ),
    );

    const result = await spinUp(null, spinUpForm({ image: "postgres:16-alpine" }));

    expect(result).toEqual({
      ok: false,
      error:
        "Created cache, but Railway refused to deploy it. Destroy it and try again.",
    });
    expect(record("container.created")).toMatchObject({
      project_id: "p1",
      environment_id: "e1",
      service_name: "spun-cache",
      service_id: "svc_orphan",
      image: "postgres:16-alpine",
      deployment_id: null,
      outcome: "deploy_failed",
      variable_names: "POSTGRES_PASSWORD",
    });
    // The un-deployed service has to appear in the list for the user to destroy it.
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard");
    // Names only, on the failure path as much as on the success one.
    expect(generated).not.toBe("");
    expect(rawLogLines().join("")).not.toContain(generated);
  });

  it("records the attempt when the service itself could not be created", async () => {
    // Nothing exists on Railway, so there is nothing to name — but "who tried to create
    // what, from which image" is the question the audit trail is for, and reportError's
    // own line carries none of it.
    server.use(
      api.mutation("ServiceCreate", () =>
        HttpResponse.json({ errors: [{ message: "Not Authorized" }] }),
      ),
    );

    const result = await spinUp(null, spinUpForm());

    expect(result).toMatchObject({ ok: false });
    expect(record("container.create_failed")).toMatchObject({
      project_id: "p1",
      environment_id: "e1",
      service_name: "spun-cache",
      image: "redis:7-alpine",
    });
    // No service was created, so nothing may claim one was.
    expect(record("container.created")).toBeUndefined();
  });

  describe("double submits", () => {
    /**
     * A working create path that counts what actually reached Railway.
     *
     * The count is the whole assertion surface for this block: what a repeat is told
     * matters less than whether it made a second container.
     */
    const countingCreate = () => {
      const calls = { create: 0 };
      server.use(
        api.mutation("ServiceCreate", () => {
          calls.create += 1;
          return HttpResponse.json({
            data: { serviceCreate: { id: `svc_${calls.create}`, name: "spun-cache" } },
          });
        }),
        api.mutation("ServiceInstanceDeployV2", () =>
          HttpResponse.json({ data: { serviceInstanceDeployV2: "dep" } }),
        ),
      );
      return calls;
    };

    it("creates one container for two submissions carrying the same key", async () => {
      const calls = countingCreate();
      const data = spinUpForm();

      const first = await spinUp(null, data);
      const second = await spinUp(null, data);

      expect(calls.create).toBe(1);
      // The same answer, not an error: the person got what they asked for, and telling
      // them otherwise for pressing twice would be a lie about a container that exists.
      expect(first).toEqual({ ok: true, message: "Spinning up cache" });
      expect(second).toEqual(first);
      expect(record("container.create_replayed")).toMatchObject({
        project_id: "p1",
        environment_id: "e1",
        service_name: "spun-cache",
      });
      // The replay ran no create of its own, so nothing revalidated on its behalf.
      expect(revalidatePath).toHaveBeenCalledTimes(2);
    });

    it("waits for a submission still in flight rather than starting a second", async () => {
      /*
       * The case the old name lookup could not close. Two submissions a millisecond
       * apart both read a container list without the name in it and both created one;
       * reading a list is not holding a lock.
       */
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let creates = 0;
      server.use(
        api.mutation("ServiceCreate", async () => {
          creates += 1;
          await gate;
          return HttpResponse.json({
            data: { serviceCreate: { id: "svc_new", name: "spun-cache" } },
          });
        }),
        api.mutation("ServiceInstanceDeployV2", () =>
          HttpResponse.json({ data: { serviceInstanceDeployV2: "dep" } }),
        ),
      );

      const data = spinUpForm();
      const both = Promise.all([spinUp(null, data), spinUp(null, data)]);
      release();
      const [first, second] = await both;

      expect(creates).toBe(1);
      expect(first).toEqual({ ok: true, message: "Spinning up cache" });
      expect(second).toEqual(first);
    });

    it("creates twice for two submissions carrying different keys", async () => {
      // The guard against a key that is accepted and then ignored: two real spin-ups of
      // the same name are still two spin-ups.
      const calls = countingCreate();

      await spinUp(null, spinUpForm());
      await spinUp(null, spinUpForm());

      expect(calls.create).toBe(2);
    });

    it("releases the key when Railway refused the create", async () => {
      /*
       * A failure has to stay retryable. The form keeps its key precisely so pressing
       * the button again is the same submission — and if a refusal were retained, one
       * blip from Railway would leave that form unable to work for the whole window.
       */
      const data = spinUpForm();
      server.use(
        api.mutation("ServiceCreate", () =>
          HttpResponse.json({ errors: [{ message: "Too many requests" }] }),
        ),
      );

      await expect(spinUp(null, data)).resolves.toMatchObject({ ok: false });

      const calls = countingCreate();
      await expect(spinUp(null, data)).resolves.toEqual({
        ok: true,
        message: "Spinning up cache",
      });
      expect(calls.create).toBe(1);
    });

    it("replays a service that was created but not deployed", async () => {
      /*
       * The branch that matters most. A repeat here must not make a second orphan — and
       * it must still be told the name of the first, because that sentence is the only
       * thing pointing at a billable service the list may not show yet.
       */
      let creates = 0;
      server.use(
        api.mutation("ServiceCreate", () => {
          creates += 1;
          return HttpResponse.json({
            data: { serviceCreate: { id: "svc_orphan", name: "spun-cache" } },
          });
        }),
        api.mutation("ServiceInstanceDeployV2", () =>
          HttpResponse.json({ errors: [{ message: "Not Authorized" }] }),
        ),
      );

      const data = spinUpForm();
      const expected = {
        ok: false,
        error:
          "Created cache, but Railway refused to deploy it. Destroy it and try again.",
      };

      await expect(spinUp(null, data)).resolves.toEqual(expected);
      await expect(spinUp(null, data)).resolves.toEqual(expected);
      expect(creates).toBe(1);
      // This branch does not refresh the list from the client, so the replay's own
      // revalidation is what puts the orphan on screen for the person told to destroy it.
      expect(revalidatePath).toHaveBeenCalledTimes(2);
    });

    it("does not serve one user's submission to another", async () => {
      // The key half is client-supplied, so two browsers can send the same one. Only the
      // user half makes a retained result unclaimable by anybody else.
      const calls = countingCreate();
      const data = spinUpForm({ idempotencyKey: "0123456789abcdef0123456789abcdef" });

      await spinUp(null, data);
      requireSession.mockResolvedValue({ user: { id: "u2" }, accessToken: "token" });
      await spinUp(null, data);

      expect(calls.create).toBe(2);
    });

    it("refuses a submission carrying no key at all, before any network call", async () => {
      // No MSW handler is registered: a request here would fail the suite.
      const data = spinUpForm();
      data.delete("idempotencyKey");

      const result = await spinUp(null, data);

      expect(result).toEqual({
        ok: false,
        error: "This form could not be submitted. Reload the page and try again.",
      });
    });

    it("refuses a key too short to be unguessable", async () => {
      const result = await spinUp(null, spinUpForm({ idempotencyKey: "abc" }));

      expect(result).toMatchObject({ ok: false });
      // Unattributed on purpose: there is no field on screen to hang it on.
      expect(!result.ok && result.field).toBeUndefined();
    });
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
    data.append("idempotencyKey", newIdempotencyKey());
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
    requireSession.mockRejectedValue(new SessionExpiredError());

    const result = await spinUp(null, spinUpForm());

    expect(result).toEqual({
      ok: false,
      error: "Your Railway session expired. Sign in again.",
    });
  });

  it("does not leak an unexpected internal error", async () => {
    requireSession.mockRejectedValue(new Error("ECONNREFUSED 10.0.0.1"));

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

describe("createProject", () => {
  const created = (id = "proj_new", name = "Client work") => ({
    data: {
      projectCreate: {
        id,
        name,
        environments: { edges: [{ node: { id: "env_new", name: "production" } }] },
      },
    },
  });

  it("creates an unprefixed personal project and selects it", async () => {
    const sent: Array<Record<string, unknown>> = [];
    server.use(
      api.mutation("ProjectCreate", ({ variables }) => {
        sent.push(variables);
        return HttpResponse.json(created());
      }),
    );

    const result = await createProject(null, form({ projectName: "Client work" }));

    expect(result).toEqual({
      ok: true,
      message: "Created Client work",
      // The default environment Railway made with the project rides back in the same
      // response, which is what lets the dashboard land on it without a second read.
      select: { projectId: "proj_new", environmentId: "env_new" },
    });
    /*
     * No MANAGED_PREFIX, and no other member of ProjectCreateInput. The prefix gates
     * destroy and this app never deletes a project, so marking one would only put `spun-`
     * on a name the user reads back in Railway's own dashboard.
     */
    expect(sent[0]?.input).toEqual({ name: "Client work" });
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard");
  });

  it("records the creation of billable infrastructure", async () => {
    server.use(api.mutation("ProjectCreate", () => HttpResponse.json(created())));

    await createProject(null, form({ projectName: "Client work" }));

    expect(record("project.created")).toMatchObject({
      project_id: "proj_new",
      project_name: "Client work",
      environment_count: 1,
    });
  });

  it("selects the project alone when Railway returns no environment with it", async () => {
    server.use(
      api.mutation("ProjectCreate", () =>
        HttpResponse.json({
          data: {
            projectCreate: {
              id: "proj_new",
              name: "Bare",
              environments: { edges: [] },
            },
          },
        }),
      ),
    );

    const result = await createProject(null, form({ projectName: "Bare" }));

    // Naming an environment id that does not exist would be worse than saying nothing;
    // the picker already has a sentence for a project without environments.
    expect(result).toEqual({
      ok: true,
      message: "Created Bare",
      select: { projectId: "proj_new" },
    });
  });

  it("attributes a name that is too long to the field, and sends nothing", async () => {
    // No handler registered: onUnhandledRequest is "error", so a request here fails loudly.
    const result = await createProject(null, form({ projectName: "x".repeat(65) }));

    expect(result).toEqual({
      ok: false,
      field: "projectName",
      error: "Keep the name under 64 characters",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses a blank name", async () => {
    const result = await createProject(null, form({ projectName: "   " }));
    expect(result).toEqual({
      ok: false,
      field: "projectName",
      error: "Give the project a name",
    });
  });

  it("turns a refusal into a catalog message with no upstream text", async () => {
    server.use(
      api.mutation("ProjectCreate", () =>
        HttpResponse.json({
          data: null,
          errors: [{ message: "Not Authorized", path: ["projectCreate"] }],
        }),
      ),
    );

    const result = await createProject(null, form({ projectName: "Client work" }));

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("Not Authorized");
  });
});

describe("createEnvironment", () => {
  const envForm = (over: Record<string, string> = {}) =>
    form({ projectId: "p1", environmentName: "staging", ...over });

  it("creates an empty environment and selects it", async () => {
    const sent: Array<Record<string, unknown>> = [];
    server.use(
      api.mutation("EnvironmentCreate", ({ variables }) => {
        sent.push(variables);
        return HttpResponse.json({
          data: { environmentCreate: { id: "env_new", name: "staging" } },
        });
      }),
    );

    const result = await createEnvironment(null, envForm());

    expect(result).toEqual({
      ok: true,
      message: "Created staging",
      select: { projectId: "p1", environmentId: "env_new" },
    });
    /*
     * `skipInitialDeploys` is the assertion that matters here. Railway seeds a new
     * environment from an existing one and deploys what it copies, so losing this member
     * would silently bill someone for a duplicate of every service in the project.
     */
    expect(sent[0]?.input).toEqual({
      projectId: "p1",
      name: "staging",
      skipInitialDeploys: true,
    });
    expect(record("environment.created")).toMatchObject({
      project_id: "p1",
      environment_id: "env_new",
      environment_name: "staging",
    });
  });

  it("attributes a bad name to the field", async () => {
    const result = await createEnvironment(null, envForm({ environmentName: "" }));
    expect(result).toEqual({
      ok: false,
      field: "environmentName",
      error: "Give the environment a name",
    });
  });

  it("toasts rather than points at a field when the hidden project id is bad", async () => {
    const result = await createEnvironment(null, envForm({ projectId: "not a/id" }));

    // Nothing on screen to attribute it to — the picker filled that input in — so the
    // absent `field` is what routes this to a toast.
    expect(result).toEqual({
      ok: false,
      error:
        "That reference is not one Railway could have issued. Reload the page and try again.",
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
