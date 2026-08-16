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
import { rawLogLines } from "@/test/log-capture";
import { spinUpForm, spinUpFormWith, record } from "@/test/dashboard-fixtures";

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

const { spinUp } = await import("./actions");
const { __resetIdempotency } = await import("@/lib/idempotency");
const { newIdempotencyKey } = await import("@/lib/random-id");
const { SessionExpiredError } = await import("@/lib/auth/refresh");

const api = graphql.link(railwayApiUrl());
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

beforeEach(() => {
  revalidatePath.mockClear();
  requireAccessToken.mockReset();
  requireAccessToken.mockResolvedValue("token");
  requireSession.mockReset();
  requireSession.mockResolvedValue({ user: { id: "u1" }, accessToken: "token" });
  // Retained results are process-global and outlive the call that made them, so without
  // this a case would be served a previous case's container.
  __resetIdempotency();

  /*
   * `volumeCreate` answering, by default, because since T-491 it is an ordinary step of
   * creating the image every case in this file uses — redis keeps state, so it takes a
   * volume before it deploys. A default rather than a line in each case: without one, every
   * spin-up test would be silently exercising the `volume_failed` branch, and the cases
   * that mean to test that branch register their own refusal, which MSW ranks above this.
   */
  server.use(
    api.mutation("VolumeCreate", () =>
      HttpResponse.json({
        data: { volumeCreate: { id: "vol_1", name: "spun-cache-volume" } },
      }),
    ),
    /*
     * An environment with no volumes in it, which is what most environments are — and
     * `spinDown` reads this on every destroy now, not only when the box was ticked, because
     * the answer decides which sentence is true rather than which one was asked for. The
     * cases that care about a volume register their own.
     */
    api.query("EnvironmentVolumes", () =>
      HttpResponse.json({
        data: { environment: { id: "e1", volumeInstances: { edges: [] } } },
      }),
    ),
  );
});

/**
 * Spin-up, including the public port and the double-submit guard.
 *
 * Split from actions.integration.test.ts along the same seam the source module was, so a
 * verb's cases sit beside the module that implements it.
 */

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

  describe("the public port", () => {
    /** A working create and deploy, with whatever the domain call did handed back. */
    const creating = () => {
      const minted: Array<Record<string, unknown>> = [];
      server.use(
        api.mutation("ServiceCreate", () =>
          HttpResponse.json({
            data: { serviceCreate: { id: "svc_new", name: "spun-web" } },
          }),
        ),
        api.mutation("ServiceInstanceDeployV2", () =>
          HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_new" } }),
        ),
        api.mutation("ServiceDomainCreate", ({ variables }) => {
          minted.push(variables.input as Record<string, unknown>);
          return HttpResponse.json({
            data: {
              serviceDomainCreate: {
                id: "dom_1",
                domain: "spun-web-production.up.railway.app",
                targetPort: 80,
              },
            },
          });
        }),
      );
      return minted;
    };

    it("mints a domain and puts the url in the sentence", async () => {
      const minted = creating();

      const result = await spinUp(
        null,
        spinUpForm({ name: "web", image: "nginx:alpine", port: "80" }),
      );

      expect(result).toEqual({
        ok: true,
        message:
          "Spinning up web. It will answer at https://spun-web-production.up.railway.app once it is running.",
      });
      expect(minted[0]).toEqual({
        environmentId: "e1",
        serviceId: "svc_new",
        targetPort: 80,
      });
    });

    /*
     * A blank port is what every database preset submits and what a person types when they
     * clear the seeded 80. It is a request for no public address, not an incomplete form —
     * so the mutation must not be reached at all.
     */
    it("mints nothing, and says nothing, when the port is blank", async () => {
      server.use(
        api.mutation("ServiceCreate", () =>
          HttpResponse.json({
            data: { serviceCreate: { id: "svc_new", name: "spun-cache" } },
          }),
        ),
        api.mutation("ServiceInstanceDeployV2", () =>
          HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_new" } }),
        ),
        api.mutation("ServiceDomainCreate", () => {
          throw new Error("must not expose a container nobody asked to expose");
        }),
      );

      const result = await spinUp(null, spinUpForm({ port: "" }));

      expect(result).toEqual({ ok: true, message: "Spinning up cache" });
    });

    it("carries both the credentials note and the url when both apply", async () => {
      const minted = creating();
      server.use(
        api.mutation("VolumeCreate", () =>
          HttpResponse.json({
            data: { volumeCreate: { id: "vol_1", name: "spun-web-volume" } },
          }),
        ),
        api.mutation("VariableCollectionUpsert", () =>
          HttpResponse.json({ data: { variableCollectionUpsert: 1 } }),
        ),
      );

      const result = await spinUp(
        null,
        spinUpFormWith([["RABBITMQ_DEFAULT_PASS", ""]], {
          name: "web",
          image: "rabbitmq:3-management",
          port: "15672",
        }),
      );

      expect(result).toMatchObject({ ok: true });
      expect(result.ok && result.message).toContain(
        "https://spun-web-production.up.railway.app",
      );
      expect(result.ok && result.message).toContain("generated credentials");
      expect(minted[0]).toMatchObject({ targetPort: 15672 });
    });

    /*
     * The one Railway refusal on this path that does not fail the spin-up. The container
     * the person asked for exists and is running; what is missing is a convenience the row
     * offers a control for.
     */
    it("still succeeds when Railway refuses the domain, and says nothing about it", async () => {
      server.use(
        api.mutation("ServiceCreate", () =>
          HttpResponse.json({
            data: { serviceCreate: { id: "svc_new", name: "spun-web" } },
          }),
        ),
        api.mutation("ServiceInstanceDeployV2", () =>
          HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_new" } }),
        ),
        api.mutation("ServiceDomainCreate", () =>
          HttpResponse.json({ errors: [{ message: "Not Authorized" }] }),
        ),
      );

      const result = await spinUp(
        null,
        spinUpForm({ name: "web", image: "nginx:alpine", port: "80" }),
      );

      expect(result).toEqual({ ok: true, message: "Spinning up web" });
      expect(record("container.created")).toMatchObject({
        outcome: "deployed",
        target_port: 80,
        domain_created: false,
      });
    });

    it("attributes a bad port to the field, so the form can render it inline", async () => {
      server.use(
        api.mutation("ServiceCreate", () => {
          throw new Error("must not create anything from a form it refused");
        }),
      );

      const result = await spinUp(null, spinUpForm({ port: "70000" }));

      expect(result).toEqual({
        ok: false,
        error: "Give a port between 1 and 65,535, or leave it blank",
        field: "port",
      });
    });
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

    /*
     * PGDATA rides along because postgres now takes a volume: the official image refuses to
     * initdb into a directory that is not empty, and a freshly provisioned volume has
     * `lost+found` in it. See the note beside it in the catalog — the variable and the mount
     * path are one decision written in two places.
     */
    expect(Object.keys(sent()!)).toEqual(["POSTGRES_PASSWORD", "PGDATA"]);
    expect(sent()!.POSTGRES_PASSWORD!.length).toBeGreaterThanOrEqual(32);
    expect(sent()!.PGDATA).toBe("/var/lib/postgresql/data/pgdata");
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
        "Created cache, but Railway refused to deploy it. Redeploy it from its row, or destroy it and start again.",
    });
    expect(record("container.created")).toMatchObject({
      project_id: "p1",
      environment_id: "e1",
      service_name: "spun-cache",
      service_id: "svc_orphan",
      image: "postgres:16-alpine",
      deployment_id: null,
      outcome: "deploy_failed",
      // PGDATA is catalog-derived too, so it belongs in the closed half of this record —
      // it arrived with the volume, and the note in the catalog says why the two travel
      // together.
      variable_names: "POSTGRES_PASSWORD,PGDATA",
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
          "Created cache, but Railway refused to deploy it. Redeploy it from its row, or destroy it and start again.",
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

describe("spinUp, with the advanced resource controls", () => {
  /** The three answers a customised spin-up needs, with what each was sent recorded. */
  const stubs = (
    sent: { settings?: Record<string, unknown>; limits?: Record<string, unknown> },
    over: {
      settingsFail?: boolean;
      limitsFail?: boolean;
      readBackFail?: boolean;
    } = {},
  ) => [
    api.mutation("ServiceCreate", () =>
      HttpResponse.json({
        data: { serviceCreate: { id: "svc_new", name: "spun-cache" } },
      }),
    ),
    api.mutation("ServiceInstanceUpdate", ({ variables }) => {
      sent.settings = (variables as { input: Record<string, unknown> }).input;
      return over.settingsFail
        ? HttpResponse.json({ errors: [{ message: "refused" }] })
        : HttpResponse.json({ data: { serviceInstanceUpdate: true } });
    }),
    api.mutation("ServiceInstanceLimitsUpdate", ({ variables }) => {
      sent.limits = (variables as { input: Record<string, unknown> }).input;
      return over.limitsFail
        ? HttpResponse.json({ errors: [{ message: "refused" }] })
        : HttpResponse.json({ data: { serviceInstanceLimitsUpdate: true } });
    }),
    api.mutation("ServiceInstanceDeployV2", () =>
      HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_new" } }),
    ),
    /*
     * The read-back, which runs only when the panel was used — so it belongs in this
     * block's stubs rather than in the file's defaults, where it would be answering for
     * the uncustomised spin-ups too.
     *
     * It answers something OTHER than what it was sent, deliberately: a retry count of 10
     * where the form asked for 4 is what Railway really returned once, and it is the value
     * that proves the `stored_` fields in the audit line are Railway's word rather than an
     * echo of the form's.
     */
    api.query("ServiceInstance", () =>
      over.readBackFail
        ? HttpResponse.json({ data: null, errors: [{ message: "Not Authorized" }] })
        : HttpResponse.json({
            data: {
              serviceInstance: {
                id: "si_new",
                numReplicas: 2,
                restartPolicyType: "ON_FAILURE",
                restartPolicyMaxRetries: 10,
                startCommand: null,
              },
            },
          }),
    ),
  ];

  it("carries the panel's values through to the two mutations", async () => {
    const sent: {
      settings?: Record<string, unknown>;
      limits?: Record<string, unknown>;
    } = {};
    server.use(...stubs(sent));

    const result = await spinUp(
      null,
      spinUpForm({
        region: "sfo",
        replicas: "2",
        cpu: "0.5",
        memory: "1",
        restartPolicy: "ON_FAILURE",
        restartRetries: "4",
        startCommand: "redis-server --appendonly yes",
      }),
    );

    expect(result).toEqual({ ok: true, message: "Spinning up cache" });
    expect(sent.settings).toEqual({
      multiRegionConfig: { sfo: { numReplicas: 2 } },
      numReplicas: 2,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 4,
      startCommand: "redis-server --appendonly yes",
    });
    expect(sent.limits).toMatchObject({ vCPUs: 0.5, memoryGB: 1 });
  });

  /*
   * The common case, asserted rather than described: a form nobody opened the panel on
   * issues the requests it always issued. `onUnhandledRequest: "error"` is what makes the
   * absence of the two new mutations an assertion — neither is stubbed here.
   */
  it("sends neither mutation when the panel was left alone", async () => {
    server.use(
      api.mutation("ServiceCreate", () =>
        HttpResponse.json({
          data: { serviceCreate: { id: "svc_new", name: "spun-cache" } },
        }),
      ),
      api.mutation("ServiceInstanceDeployV2", () =>
        HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_new" } }),
      ),
    );

    const result = await spinUp(null, spinUpForm());

    expect(result.ok).toBe(true);
  });

  /*
   * A retry count only means something under ON_FAILURE. The form disables the field for the
   * other two policies and a disabled input posts nothing, so this covers the request that
   * did not come from the form — dropped rather than refused, because carrying a number a
   * policy ignores is not a mistake anyone can act on.
   */
  it("drops a retry count sent with a policy that ignores it", async () => {
    const sent: { settings?: Record<string, unknown> } = {};
    server.use(...stubs(sent));

    const result = await spinUp(
      null,
      spinUpForm({ restartPolicy: "ALWAYS", restartRetries: "7" }),
    );

    expect(result.ok).toBe(true);
    expect(sent.settings).toEqual({ restartPolicyType: "ALWAYS" });
  });

  it("says the settings were refused, and that the container was not deployed", async () => {
    const sent = {};
    server.use(...stubs(sent, { settingsFail: true }));

    const result = await spinUp(null, spinUpForm({ replicas: "3" }));

    expect(result).toEqual({
      ok: false,
      error:
        "Created cache, but Railway refused the settings you asked for, so it was not deployed. Destroy it and try again, with the advanced settings left alone.",
    });
  });

  it("names the plan when the size is refused, without asserting it", async () => {
    const sent = {};
    server.use(...stubs(sent, { limitsFail: true }));

    const result = await spinUp(null, spinUpForm({ cpu: "8" }));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("usually a limit of the plan");
  });

  /*
   * The audit trail is the only record anywhere of how big a container was asked to be:
   * replicas times vCPU times memory is what multiplies the bill, the usage readout is a
   * workspace figure, and Railway keeps nothing once a service is destroyed.
   */
  it("records the size that was asked for, and never the start command", async () => {
    const sent = {};
    server.use(...stubs(sent));

    await spinUp(
      null,
      spinUpForm({
        region: "sfo",
        replicas: "2",
        cpu: "0.5",
        memory: "1",
        restartPolicy: "ON_FAILURE",
        restartRetries: "4",
        startCommand: "redis-server --requirepass hunter2",
      }),
    );

    expect(record("container.created")).toMatchObject({
      region: "sfo",
      replicas: 2,
      vcpus: 0.5,
      memory_gb: 1,
      restart_policy: "ON_FAILURE",
      restart_retries: 4,
      start_command_length: "redis-server --requirepass hunter2".length,
    });
    expect(rawLogLines().join("\n")).not.toContain("hunter2");
  });

  it("records what Railway stored beside what it was asked for", async () => {
    /*
     * The half of the record that is Railway's word rather than the form's, and the reason
     * it exists: every one of these controls is write-only — none is rendered anywhere
     * after the create — so a value Railway drops could previously only be found by opening
     * Railway's own dashboard and comparing by eye. One was found that way, and this stub
     * reproduces it: a retry count that came back as something other than what was sent.
     *
     * There is deliberately no `stored_region` beside the `region`. Railway answers null for
     * a service instance's region whatever it was told and wherever the container is really
     * running, so the field would report a dropped setting on every correct spin-up — and a
     * permanently-failing instrument teaches whoever reads it to ignore the whole block.
     *
     * The app cannot correct what it does find. What it can do is say so in the one line
     * that outlives the container, so the next occurrence is a log query rather than a
     * manual comparison.
     */
    const sent = {};
    server.use(...stubs(sent));

    await spinUp(
      null,
      spinUpForm({
        region: "ams",
        replicas: "2",
        restartPolicy: "ON_FAILURE",
        restartRetries: "4",
      }),
    );

    const created = record("container.created");
    expect(created).toMatchObject({
      region: "ams",
      restart_retries: 4,
      stored_replicas: 2,
      stored_restart_retries: 10,
    });
    expect(created).not.toHaveProperty("stored_region");
  });

  it("claims nothing about what Railway stored when it would not say", async () => {
    /*
     * Absent rather than zero, and the distinction is the point. A `stored_` field that
     * defaulted to the same sentinel as the field above it would read as agreement — the
     * one thing this must never say by accident — so a refused read-back drops the fields
     * entirely rather than filling them in.
     */
    const sent = {};
    server.use(...stubs(sent, { readBackFail: true }));

    await spinUp(null, spinUpForm({ replicas: "2" }));

    const created = record("container.created");
    expect(created).toMatchObject({ replicas: 2 });
    expect(created).not.toHaveProperty("stored_replicas");
  });

  it("records zero for every control nobody set", async () => {
    server.use(
      api.mutation("ServiceCreate", () =>
        HttpResponse.json({
          data: { serviceCreate: { id: "svc_new", name: "spun-cache" } },
        }),
      ),
      api.mutation("ServiceInstanceDeployV2", () =>
        HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_new" } }),
      ),
    );

    await spinUp(null, spinUpForm());

    expect(record("container.created")).toMatchObject({
      region: "",
      replicas: 0,
      vcpus: 0,
      memory_gb: 0,
      restart_policy: "",
      start_command_length: 0,
    });
  });

  it("refuses an out-of-range replica count and attributes it to the field", async () => {
    // No handlers: a refused form must reach no mutation at all, which is what
    // `onUnhandledRequest: "error"` turns into an assertion.
    const result = await spinUp(null, spinUpForm({ replicas: "99" }));

    expect(result).toEqual({
      ok: false,
      error: "Run at most 5 replicas here. Scale further on Railway.",
      field: "replicas",
    });
  });

  it("refuses a region it could not have offered, with no field to correct", async () => {
    const result = await spinUp(null, spinUpForm({ region: "NOT A REGION" }));

    expect(result).toEqual({
      ok: false,
      error: "That is not a region Railway offers. Reload the page and try again.",
    });
  });
});
