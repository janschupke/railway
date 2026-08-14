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
import { LIMITS } from "@/lib/constants";
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

const {
  spinUp,
  spinDown,
  spinDownMany,
  stopContainer,
  restartContainer,
  redeployContainer,
  generateDomain,
  editContainer,
  createProject,
  createEnvironment,
} = await import("./actions");
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
  services: Array<{
    id: string;
    name: string;
    /**
     * A service Railway reports with no deployment at all.
     *
     * The orphan a refused first deploy leaves behind, which is a real row on the dashboard
     * and the one the redeploy action exists to rescue — so it has to be expressible here.
     */
    undeployed?: boolean;
    /** What the service runs, when a case needs the catalog to recognise it or not. */
    image?: string;
    /** The host Railway already minted for it, for the branch that must not mint a second. */
    domain?: string;
  }> = [
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
                    source: { image: s.image ?? "redis:7-alpine", repo: null },
                    domains: {
                      serviceDomains: s.domain ? [{ domain: s.domain }] : [],
                    },
                    latestDeployment: s.undeployed
                      ? null
                      : {
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
    over: { settingsFail?: boolean; limitsFail?: boolean } = {},
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
        region: "us-west2",
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
      region: "us-west2",
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
        region: "us-west2",
        replicas: "2",
        cpu: "0.5",
        memory: "1",
        restartPolicy: "ON_FAILURE",
        restartRetries: "4",
        startCommand: "redis-server --requirepass hunter2",
      }),
    );

    expect(record("container.created")).toMatchObject({
      region: "us-west2",
      replicas: 2,
      vcpus: 0.5,
      memory_gb: 1,
      restart_policy: "ON_FAILURE",
      restart_retries: 4,
      start_command_length: "redis-server --requirepass hunter2".length,
    });
    expect(rawLogLines().join("\n")).not.toContain("hunter2");
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
      error: "This service was not created here, so this app cannot act on it.",
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

  describe("the stored data", () => {
    /* A body rather than a response, so each resolver keeps MSW's contextual typing. */
    const withVolume = (over: Record<string, unknown> = {}) => ({
      data: {
        environment: {
          id: "e1",
          volumeInstances: {
            edges: [
              {
                node: {
                  id: "volinst_1",
                  volumeId: "vol_1",
                  serviceId: "svc_managed",
                  mountPath: "/data",
                  sizeMB: 500,
                  currentSizeMB: 4,
                  ...over,
                },
              },
            ],
          },
        },
      },
    });

    /** The form the dialog posts with the checkbox left checked. */
    const withDeleteVolume = (serviceId: string) =>
      form({
        projectId: "p1",
        environmentId: "e1",
        serviceId,
        deleteData: "on",
      });

    it("deletes the volume when the box was checked, after the service", async () => {
      /*
       * Order is forced by Railway — it refuses to delete a volume still mounted on a live
       * service — and it is also the order that fails safe. Service first leaves at worst an
       * orphan the user can see in Railway's dashboard; volume first would at worst wipe the
       * data under a container that is still running.
       */
      const calls: string[] = [];
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        api.query("EnvironmentVolumes", () => HttpResponse.json(withVolume())),
        api.mutation("ServiceDelete", () => {
          calls.push("service");
          return HttpResponse.json({ data: { serviceDelete: true } });
        }),
        api.mutation("VolumeDelete", ({ variables }) => {
          calls.push(`volume:${variables.volumeId as string}`);
          return HttpResponse.json({ data: { volumeDelete: true } });
        }),
      );

      const result = await spinDown(null, withDeleteVolume("svc_managed"));

      expect(result).toEqual({
        ok: true,
        message: "Destroyed cache and its stored data",
      });
      expect(calls).toEqual(["service", "volume:vol_1"]);
    });

    it("keeps the volume when the box was not checked, and says so", async () => {
      /*
       * The sentence is the point, and it is why the volume read is unconditional. A kept
       * volume is billable storage that disappears from this UI along with its container —
       * the app lists containers, and an orphan volume is not one — so the outcome that
       * leaves a charge behind must not be the one that says nothing about it.
       */
      let volumeDeletes = 0;
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        api.query("EnvironmentVolumes", () => HttpResponse.json(withVolume())),
        api.mutation("ServiceDelete", () =>
          HttpResponse.json({ data: { serviceDelete: true } }),
        ),
        api.mutation("VolumeDelete", () => {
          volumeDeletes += 1;
          return HttpResponse.json({ data: { volumeDelete: true } });
        }),
      );

      const result = await spinDown(null, downForm("svc_managed"));

      expect(result).toEqual({
        ok: true,
        message:
          "Destroyed cache. Its data volume was kept and is still billed — remove it on Railway.",
      });
      expect(volumeDeletes).toBe(0);
    });

    it("never takes a volume id from the browser", async () => {
      /*
       * The client posts a boolean and a service id. A `volumeId` in the FormData is
       * ignored entirely and the id is read back from Railway — the same rule ownership and
       * the deployment id follow, and the reason is the same: a form that could name the
       * volume to delete would be a form that could name somebody else's.
       */
      let deleted: string | undefined;
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        api.query("EnvironmentVolumes", () => HttpResponse.json(withVolume())),
        api.mutation("ServiceDelete", () =>
          HttpResponse.json({ data: { serviceDelete: true } }),
        ),
        api.mutation("VolumeDelete", ({ variables }) => {
          deleted = variables.volumeId as string;
          return HttpResponse.json({ data: { volumeDelete: true } });
        }),
      );

      await spinDown(
        null,
        form({
          projectId: "p1",
          environmentId: "e1",
          serviceId: "svc_managed",
          deleteData: "on",
          volumeId: "vol_someone_elses",
        }),
      );

      expect(deleted).toBe("vol_1");
    });

    it("deletes no volume belonging to another service", async () => {
      // The join is `volumeInstance.serviceId`, and a volume mounted on a different
      // container in the same environment is not this container's to take.
      let volumeDeletes = 0;
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        api.query("EnvironmentVolumes", () =>
          HttpResponse.json(withVolume({ serviceId: "svc_other" })),
        ),
        api.mutation("ServiceDelete", () =>
          HttpResponse.json({ data: { serviceDelete: true } }),
        ),
        api.mutation("VolumeDelete", () => {
          volumeDeletes += 1;
          return HttpResponse.json({ data: { volumeDelete: true } });
        }),
      );

      const result = await spinDown(null, withDeleteVolume("svc_managed"));

      expect(volumeDeletes).toBe(0);
      /*
       * The plain sentence, not the "kept" one. No volume belongs to THIS container, so
       * there is nothing of its data left behind to warn about — the other service's volume
       * is still attached to a container the dashboard lists.
       */
      expect(result).toEqual({ ok: true, message: "Destroyed cache" });
    });

    it("deletes nothing, and claims nothing, when the volume read is refused", async () => {
      /*
       * `EnvironmentVolumes` degrades rather than throwing, and the destroy stays correct
       * through it in two halves. It deletes nothing, which is the conservative one; and it
       * says only "Destroyed", which is the honest one — with the read refused this app does
       * not know a volume exists, and claiming one was kept would be a statement it cannot
       * support. The same branch covers a volume Railway has not finished provisioning.
       *
       * README Limitations states what that leaves the user with, because it is a real gap
       * rather than a tidy one.
       */
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        api.query("EnvironmentVolumes", () =>
          HttpResponse.json({
            errors: [{ message: "Not Authorized", path: ["environment"] }],
          }),
        ),
        api.mutation("ServiceDelete", () =>
          HttpResponse.json({ data: { serviceDelete: true } }),
        ),
        api.mutation("VolumeDelete", () => {
          throw new Error("there is no volume this action knows about");
        }),
      );

      const result = await spinDown(null, withDeleteVolume("svc_managed"));

      expect(result).toEqual({ ok: true, message: "Destroyed cache" });
    });

    it("records what happened to the data, on both branches", async () => {
      /*
       * After `serviceDelete` Railway retains no record the container existed, so this line
       * is the only place the data's fate survives at all. Written whichever way it went —
       * a record that only appears on deletion cannot be read as "the volume was kept".
       */
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        api.query("EnvironmentVolumes", () => HttpResponse.json(withVolume())),
        api.mutation("ServiceDelete", () =>
          HttpResponse.json({ data: { serviceDelete: true } }),
        ),
        api.mutation("VolumeDelete", () =>
          HttpResponse.json({ data: { volumeDelete: true } }),
        ),
      );

      await spinDown(null, withDeleteVolume("svc_managed"));
      expect(logRecords().find((r) => r.msg === "container.destroyed")).toMatchObject({
        service_id: "svc_managed",
        volume_deleted: true,
        volume_id: "vol_1",
      });
    });

    it("refuses a service it did not create before reading any volume", async () => {
      // The ownership boundary is above all of this. A forged service id must not even
      // cause a volume read, let alone a delete.
      let volumeReads = 0;
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        api.query("EnvironmentVolumes", () => {
          volumeReads += 1;
          return HttpResponse.json(withVolume());
        }),
        api.mutation("ServiceDelete", () => {
          throw new Error("must not delete an unmanaged service");
        }),
      );

      const result = await spinDown(null, withDeleteVolume("svc_foreign"));

      expect(result.ok).toBe(false);
      expect(volumeReads).toBe(0);
    });
  });
});

describe("spinDownMany", () => {
  const manyForm = (
    serviceIds: string[],
    over: Record<string, string> = {},
  ): FormData => {
    const data = form({ projectId: "p1", environmentId: "e1", ...over });
    for (const id of serviceIds) data.append("serviceId", id);
    return data;
  };

  /** Three of ours and the one this app did not create. */
  const mixedProject = () =>
    projectWith([
      { id: "svc_a", name: "spun-cache" },
      { id: "svc_b", name: "spun-queue" },
      { id: "svc_c", name: "spun-web" },
      { id: "svc_foreign", name: "postgres" },
    ]);

  it("destroys every service in the batch and says how many", async () => {
    const deleted: string[] = [];
    server.use(
      api.query("Project", () => HttpResponse.json({ data: mixedProject() })),
      api.mutation("ServiceDelete", ({ variables }) => {
        deleted.push(variables.id as string);
        return HttpResponse.json({ data: { serviceDelete: true } });
      }),
    );

    const result = await spinDownMany(null, manyForm(["svc_a", "svc_b"]));

    expect(result).toEqual({ ok: true, message: "Destroyed 2 containers" });
    expect(deleted).toEqual(["svc_a", "svc_b"]);
  });

  it("re-derives ownership per service, not per batch", async () => {
    /*
     * The load-bearing safety test, and the one the whole feature is bounded by. A batch is
     * a list of individual decisions taken against one read — never one decision about a
     * list — so a foreign service travelling alongside two of ours is refused on its own
     * while the other two go through.
     */
    const deleted: string[] = [];
    server.use(
      api.query("Project", () => HttpResponse.json({ data: mixedProject() })),
      api.mutation("ServiceDelete", ({ variables }) => {
        deleted.push(variables.id as string);
        return HttpResponse.json({ data: { serviceDelete: true } });
      }),
    );

    const result = await spinDownMany(
      null,
      manyForm(["svc_a", "svc_foreign", "svc_b"]),
    );

    expect(deleted).toEqual(["svc_a", "svc_b"]);
    expect(result).toEqual({
      ok: true,
      message:
        "Destroyed 2 of 3. The rest are still listed — they were already gone, were not created here, or Railway refused.",
    });
    expect(record("container.destroy_refused")).toMatchObject({
      reason: "unmanaged",
      service_id: "svc_foreign",
    });
  });

  it("reads the container list once for the whole batch", async () => {
    /*
     * The reason this is not `withManagedContainer` in a loop. Six services through the
     * singular helper would be six full project queries plus six volume reads, against a
     * quota Railway documents at 1,000 requests an hour.
     */
    let projectReads = 0;
    let volumeReads = 0;
    server.use(
      api.query("Project", () => {
        projectReads += 1;
        return HttpResponse.json({ data: mixedProject() });
      }),
      api.query("EnvironmentVolumes", () => {
        volumeReads += 1;
        return HttpResponse.json({
          data: { environment: { id: "e1", volumeInstances: { edges: [] } } },
        });
      }),
      api.mutation("ServiceDelete", () =>
        HttpResponse.json({ data: { serviceDelete: true } }),
      ),
    );

    await spinDownMany(null, manyForm(["svc_a", "svc_b", "svc_c"]));

    expect(projectReads).toBe(1);
    expect(volumeReads).toBe(1);
  });

  it("writes one audit line per service, never one naming the batch", async () => {
    /*
     * The moment this stopped being an audit trail and started being a counter would be a
     * single record listing six service ids. Once Railway has answered `serviceDelete` it
     * retains no record any of them existed.
     */
    server.use(
      api.query("Project", () => HttpResponse.json({ data: mixedProject() })),
      api.mutation("ServiceDelete", () =>
        HttpResponse.json({ data: { serviceDelete: true } }),
      ),
    );

    await spinDownMany(null, manyForm(["svc_a", "svc_b"]));

    const destroyed = logRecords().filter((r) => r.msg === "container.destroyed");
    expect(destroyed.map((r) => r.service_name)).toEqual(["spun-cache", "spun-queue"]);
  });

  it("skips a service that has already gone and destroys the rest", async () => {
    server.use(
      api.query("Project", () => HttpResponse.json({ data: mixedProject() })),
      api.mutation("ServiceDelete", () =>
        HttpResponse.json({ data: { serviceDelete: true } }),
      ),
    );

    const result = await spinDownMany(null, manyForm(["svc_a", "svc_gone"]));

    expect(result).toEqual({
      ok: true,
      message:
        "Destroyed 1 of 2. The rest are still listed — they were already gone, were not created here, or Railway refused.",
    });
    expect(record("container.destroy_skipped")).toMatchObject({
      reason: "gone",
      service_id: "svc_gone",
    });
  });

  it("carries on past a service Railway refuses, and names it", async () => {
    /*
     * The services already destroyed are gone whatever happens next, so abandoning the
     * batch would end the request with an error and no account of them at all.
     */
    const deleted: string[] = [];
    server.use(
      api.query("Project", () => HttpResponse.json({ data: mixedProject() })),
      api.mutation("ServiceDelete", ({ variables }) => {
        if (variables.id === "svc_b") {
          return HttpResponse.json({ errors: [{ message: "nope" }] }, { status: 500 });
        }
        deleted.push(variables.id as string);
        return HttpResponse.json({ data: { serviceDelete: true } });
      }),
    );

    const result = await spinDownMany(null, manyForm(["svc_a", "svc_b", "svc_c"]));

    expect(deleted).toEqual(["svc_a", "svc_c"]);
    expect(result.ok).toBe(true);
    expect(record("container.destroy_failed")).toMatchObject({
      service_id: "svc_b",
    });
  });

  it("fails the whole request when nothing in the batch could be destroyed", async () => {
    server.use(api.query("Project", () => HttpResponse.json({ data: mixedProject() })));

    const result = await spinDownMany(null, manyForm(["svc_foreign", "svc_gone"]));

    expect(result).toEqual({
      ok: false,
      error:
        "None of the 2 containers could be destroyed. They were already gone, were not created here, or Railway refused.",
    });
  });

  it("destroys a repeated service id once rather than reporting a failure", async () => {
    // A shape no browser produces and a hand-written form does: destroying it twice would
    // make the batch lie about its own outcome.
    const deleted: string[] = [];
    server.use(
      api.query("Project", () => HttpResponse.json({ data: mixedProject() })),
      api.mutation("ServiceDelete", ({ variables }) => {
        deleted.push(variables.id as string);
        return HttpResponse.json({ data: { serviceDelete: true } });
      }),
    );

    const result = await spinDownMany(null, manyForm(["svc_a", "svc_a"]));

    expect(deleted).toEqual(["svc_a"]);
    expect(result).toEqual({ ok: true, message: "Destroyed 1 container" });
  });

  it("refuses an oversized batch before it reads anything", async () => {
    let projectReads = 0;
    let deleteCalls = 0;
    server.use(
      api.query("Project", () => {
        projectReads += 1;
        return HttpResponse.json({ data: mixedProject() });
      }),
      api.mutation("ServiceDelete", () => {
        deleteCalls += 1;
        return HttpResponse.json({ data: { serviceDelete: true } });
      }),
    );

    const ids = Array.from(
      { length: LIMITS.BULK_DESTROY_MAX + 1 },
      (_, i) => `svc_${i}`,
    );
    const result = await spinDownMany(null, manyForm(ids));

    expect(result).toEqual({
      ok: false,
      error: `Select at most ${LIMITS.BULK_DESTROY_MAX} containers to destroy at once.`,
    });
    // The ceiling protects the quota, so it has to bite before anything is spent on it.
    expect(projectReads).toBe(0);
    expect(deleteCalls).toBe(0);
  });

  it("rejects a request naming no service at all", async () => {
    const result = await spinDownMany(null, manyForm([]));
    expect(result.ok).toBe(false);
  });

  describe("the stored data", () => {
    const volumesFor = (serviceIds: string[]) => ({
      data: {
        environment: {
          id: "e1",
          volumeInstances: {
            edges: serviceIds.map((serviceId, index) => ({
              node: {
                id: `volinst_${index}`,
                volumeId: `vol_${index}`,
                serviceId,
                mountPath: "/data",
                sizeMB: 500,
                currentSizeMB: 4,
              },
            })),
          },
        },
      },
    });

    it("deletes every volume in the batch when the box was ticked", async () => {
      const volumesDeleted: string[] = [];
      server.use(
        api.query("Project", () => HttpResponse.json({ data: mixedProject() })),
        api.query("EnvironmentVolumes", () =>
          HttpResponse.json(volumesFor(["svc_a", "svc_b"])),
        ),
        api.mutation("ServiceDelete", () =>
          HttpResponse.json({ data: { serviceDelete: true } }),
        ),
        api.mutation("VolumeDelete", ({ variables }) => {
          volumesDeleted.push(variables.volumeId as string);
          return HttpResponse.json({ data: { volumeDelete: true } });
        }),
      );

      await spinDownMany(null, manyForm(["svc_a", "svc_b"], { deleteData: "on" }));

      expect(volumesDeleted).toEqual(["vol_0", "vol_1"]);
    });

    it("keeps every volume when it was not", async () => {
      let volumeDeletes = 0;
      server.use(
        api.query("Project", () => HttpResponse.json({ data: mixedProject() })),
        api.query("EnvironmentVolumes", () =>
          HttpResponse.json(volumesFor(["svc_a", "svc_b"])),
        ),
        api.mutation("ServiceDelete", () =>
          HttpResponse.json({ data: { serviceDelete: true } }),
        ),
        api.mutation("VolumeDelete", () => {
          volumeDeletes += 1;
          return HttpResponse.json({ data: { volumeDelete: true } });
        }),
      );

      // Unticked is the default here, unlike the single destroy: one tick covers containers
      // whose volumes the reader has not seen individually.
      await spinDownMany(null, manyForm(["svc_a", "svc_b"]));

      expect(volumeDeletes).toBe(0);
      expect(record("container.destroyed")).toMatchObject({ volume_deleted: false });
    });

    it("leaves a container without a volume alone", async () => {
      const volumesDeleted: string[] = [];
      server.use(
        api.query("Project", () => HttpResponse.json({ data: mixedProject() })),
        api.query("EnvironmentVolumes", () => HttpResponse.json(volumesFor(["svc_a"]))),
        api.mutation("ServiceDelete", () =>
          HttpResponse.json({ data: { serviceDelete: true } }),
        ),
        api.mutation("VolumeDelete", ({ variables }) => {
          volumesDeleted.push(variables.volumeId as string);
          return HttpResponse.json({ data: { volumeDelete: true } });
        }),
      );

      await spinDownMany(null, manyForm(["svc_a", "svc_b"], { deleteData: "on" }));

      expect(volumesDeleted).toEqual(["vol_0"]);
    });
  });
});

/**
 * Stop, restart and redeploy.
 *
 * They post the same three ids `spinDown` does and run through the same ownership
 * re-derivation, so the cases that matter are per verb rather than shared: which mutation
 * reaches Railway, which deployment id it carries, and that an unmanaged service reaches
 * none of them. The refusal test is repeated for each deliberately — it is the one property
 * this whole feature is bounded by, and a shared helper asserting it once would let a verb
 * be added that skips the guard while the suite stayed green.
 */
describe("container lifecycle", () => {
  const actionForm = (serviceId: string, environmentId = "e1") =>
    form({ projectId: "p1", environmentId, serviceId });

  describe("stopContainer", () => {
    it("stops the deployment Railway reported, not one the client sent", async () => {
      const stopped: string[] = [];
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        api.mutation("DeploymentStop", ({ variables }) => {
          stopped.push(variables.id as string);
          return HttpResponse.json({ data: { deploymentStop: true } });
        }),
      );

      /*
       * A deployment id is posted alongside the service id and is expected to be ignored:
       * the action reads the id off the container it just re-derived ownership from, which
       * is the same rule that stops a forged serviceId working.
       */
      const data = actionForm("svc_managed");
      data.append("deploymentId", "dep_someone_elses");

      const result = await stopContainer(null, data);

      expect(result).toEqual({ ok: true, message: "Stopped cache" });
      expect(stopped).toEqual(["dep_svc_managed"]);
      expect(revalidatePath).toHaveBeenCalledWith("/dashboard");
    });

    it("refuses to stop a service it did not create", async () => {
      let stopCalls = 0;
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        api.mutation("DeploymentStop", () => {
          stopCalls += 1;
          return HttpResponse.json({ data: { deploymentStop: true } });
        }),
      );

      const result = await stopContainer(null, actionForm("svc_foreign"));

      expect(result).toEqual({
        ok: false,
        error: "This service was not created here, so this app cannot act on it.",
      });
      expect(stopCalls).toBe(0);
      expect(record("container.stop_refused")).toMatchObject({
        reason: "unmanaged",
        service_id: "svc_foreign",
      });
    });

    it("records what it stopped", async () => {
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        api.mutation("DeploymentStop", () =>
          HttpResponse.json({ data: { deploymentStop: true } }),
        ),
      );

      await stopContainer(null, actionForm("svc_managed"));

      // The audit trail this action shares with create and destroy: stopping changes what
      // is billed, so the record names the service and the deployment.
      expect(record("container.stopped")).toMatchObject({
        project_id: "p1",
        environment_id: "e1",
        service_id: "svc_managed",
        service_name: "spun-cache",
        deployment_id: "dep_svc_managed",
      });
    });

    it("says so when the service has no deployment to stop", async () => {
      // No DeploymentStop handler: onUnhandledRequest is "error", so an attempted
      // mutation fails the case rather than being asserted for.
      server.use(
        api.query("Project", () =>
          HttpResponse.json({
            data: projectWith([
              { id: "svc_managed", name: "spun-cache", undeployed: true },
            ]),
          }),
        ),
      );

      const result = await stopContainer(null, actionForm("svc_managed"));

      expect(result).toEqual({
        ok: false,
        error:
          "That container has no deployment to act on. Reload the page and try again.",
      });
    });

    it("reports a service that has already gone and refreshes the list", async () => {
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
      );

      const result = await stopContainer(null, actionForm("svc_missing"));

      expect(result).toEqual({ ok: false, error: "That container no longer exists." });
      expect(record("container.stop_skipped")).toMatchObject({ reason: "gone" });
      expect(revalidatePath).toHaveBeenCalledWith("/dashboard");
    });

    it("propagates a refused stop as a readable message", async () => {
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        api.mutation("DeploymentStop", () =>
          HttpResponse.json({ errors: [{ message: "Deployment is locked" }] }),
        ),
      );

      const result = await stopContainer(null, actionForm("svc_managed"));

      expect(result).toMatchObject({
        ok: false,
        error: expect.stringMatching(
          /^Railway refused this operation .* Reference [0-9a-f]{8}\.$/,
        ),
      });
      expect(JSON.stringify(result)).not.toContain("Deployment is locked");
    });
  });

  describe("restartContainer", () => {
    it("restarts the deployment in place", async () => {
      const restarted: string[] = [];
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        api.mutation("DeploymentRestart", ({ variables }) => {
          restarted.push(variables.id as string);
          return HttpResponse.json({ data: { deploymentRestart: true } });
        }),
      );

      const result = await restartContainer(null, actionForm("svc_managed"));

      expect(result).toEqual({ ok: true, message: "Restarting cache" });
      /*
       * The same deployment id, which is the whole difference between this and redeploy:
       * a log pane already subscribed to it keeps streaming rather than being left on a
       * deployment nobody is looking at.
       */
      expect(restarted).toEqual(["dep_svc_managed"]);
      expect(record("container.restarted")).toMatchObject({
        service_id: "svc_managed",
        deployment_id: "dep_svc_managed",
      });
    });

    it("refuses to restart a service it did not create", async () => {
      let restartCalls = 0;
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        api.mutation("DeploymentRestart", () => {
          restartCalls += 1;
          return HttpResponse.json({ data: { deploymentRestart: true } });
        }),
      );

      const result = await restartContainer(null, actionForm("svc_foreign"));

      expect(result).toMatchObject({ ok: false });
      expect(restartCalls).toBe(0);
    });
  });

  describe("redeployContainer", () => {
    it("deploys the service instance and records the new deployment", async () => {
      const deployed: Array<Record<string, unknown>> = [];
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        api.mutation("ServiceInstanceDeployV2", ({ variables }) => {
          deployed.push(variables);
          return HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_fresh" } });
        }),
      );

      const result = await redeployContainer(null, actionForm("svc_managed"));

      expect(result).toEqual({ ok: true, message: "Redeploying cache" });
      expect(deployed[0]).toMatchObject({
        serviceId: "svc_managed",
        environmentId: "e1",
      });
      // The new id, not the old one — this is the record that says which deployment the
      // row is about to stream.
      expect(record("container.redeployed")).toMatchObject({
        service_id: "svc_managed",
        deployment_id: "dep_fresh",
      });
    });

    it("redeploys a service whose first deploy Railway refused", async () => {
      /*
       * The case that decided which mutation backs this action. `deploymentRedeploy` takes
       * a deployment id and this service has none, so the only call that can rescue the
       * orphan is `serviceInstanceDeployV2` — which is what spin-up's own
       * "Redeploy it from its row" sentence promises.
       */
      server.use(
        api.query("Project", () =>
          HttpResponse.json({
            data: projectWith([
              { id: "svc_managed", name: "spun-cache", undeployed: true },
            ]),
          }),
        ),
        api.mutation("ServiceInstanceDeployV2", () =>
          HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_first" } }),
        ),
      );

      const result = await redeployContainer(null, actionForm("svc_managed"));

      expect(result).toEqual({ ok: true, message: "Redeploying cache" });
    });

    it("refuses to redeploy a service it did not create", async () => {
      let deployCalls = 0;
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        api.mutation("ServiceInstanceDeployV2", () => {
          deployCalls += 1;
          return HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_x" } });
        }),
      );

      const result = await redeployContainer(null, actionForm("svc_foreign"));

      expect(result).toMatchObject({ ok: false });
      expect(deployCalls).toBe(0);
    });

    it("refuses an owned service posted against another environment", async () => {
      /*
       * Ownership is derived per environment, and this action sends an environment id to
       * Railway — so a service that has no instance in the environment submitted is
       * unknown here, and the action refuses rather than deploying it somewhere the user
       * was not looking.
       */
      let deployCalls = 0;
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        api.mutation("ServiceInstanceDeployV2", () => {
          deployCalls += 1;
          return HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_x" } });
        }),
      );

      const result = await redeployContainer(null, actionForm("svc_managed", "e2"));

      expect(result).toEqual({ ok: false, error: "That container no longer exists." });
      expect(deployCalls).toBe(0);
    });
  });

  describe("generateDomain", () => {
    /** Railway minting a hostname, with the input handed back to the caller. */
    const domainOk = (onCall?: (input: Record<string, unknown>) => void) =>
      api.mutation("ServiceDomainCreate", ({ variables }) => {
        onCall?.(variables.input as Record<string, unknown>);
        return HttpResponse.json({
          data: {
            serviceDomainCreate: {
              id: "dom_1",
              domain: "spun-web-production.up.railway.app",
              targetPort: 80,
            },
          },
        });
      });

    it("mints a domain and names it in the sentence", async () => {
      server.use(
        api.query("Project", () =>
          HttpResponse.json({
            data: projectWith([
              { id: "svc_managed", name: "spun-web", image: "nginx:alpine" },
            ]),
          }),
        ),
        domainOk(),
      );

      const result = await generateDomain(null, actionForm("svc_managed"));

      expect(result).toEqual({
        ok: true,
        message: "web is now at https://spun-web-production.up.railway.app",
      });
      expect(revalidatePath).toHaveBeenCalledWith("/dashboard");
    });

    /*
     * The rule this action is built on. The browser posts three ids and nothing else, so the
     * port cannot be chosen by the request — it comes from the catalog, keyed on the image
     * Railway itself reported for the service.
     */
    it("takes the port from the catalog rather than from the request", async () => {
      let input: Record<string, unknown> | undefined;
      server.use(
        api.query("Project", () =>
          HttpResponse.json({
            data: projectWith([
              { id: "svc_managed", name: "spun-web", image: "nginx:alpine" },
            ]),
          }),
        ),
        domainOk((i) => (input = i)),
      );

      const data = actionForm("svc_managed");
      data.append("port", "9999");

      await generateDomain(null, data);

      expect(input).toEqual({
        environmentId: "e1",
        serviceId: "svc_managed",
        targetPort: 80,
      });
      expect(record("container.domain_created")).toMatchObject({
        service_id: "svc_managed",
        target_port: 80,
      });
    });

    it("lets Railway infer the port for an image the catalog does not know", async () => {
      let input: Record<string, unknown> | undefined;
      server.use(
        api.query("Project", () =>
          HttpResponse.json({
            data: projectWith([
              { id: "svc_managed", name: "spun-api", image: "ghcr.io/owner/api:1" },
            ]),
          }),
        ),
        domainOk((i) => (input = i)),
      );

      await generateDomain(null, actionForm("svc_managed"));

      expect("targetPort" in (input ?? {})).toBe(false);
      // Zero, so the record distinguishes "the app chose 80" from "Railway chose" — which
      // is the question asked when a domain points somewhere unexpected.
      expect(record("container.domain_created")).toMatchObject({ target_port: 0 });
    });

    /*
     * `serviceDomainCreate` mints a SECOND domain rather than refusing one, so a stale page
     * or two tabs would leave a service with two hostnames and a row showing whichever
     * sorted first. The guard is on Railway's own answer, like the ownership check above it.
     */
    it("refuses a container that already has an address, without calling Railway", async () => {
      let mintCalls = 0;
      server.use(
        api.query("Project", () =>
          HttpResponse.json({
            data: projectWith([
              {
                id: "svc_managed",
                name: "spun-web",
                image: "nginx:alpine",
                domain: "spun-web-production.up.railway.app",
              },
            ]),
          }),
        ),
        api.mutation("ServiceDomainCreate", () => {
          mintCalls += 1;
          return HttpResponse.json({
            data: {
              serviceDomainCreate: { id: "dom_2", domain: "second", targetPort: 80 },
            },
          });
        }),
      );

      const result = await generateDomain(null, actionForm("svc_managed"));

      expect(result).toEqual({
        ok: false,
        error: "web already has a public URL. Reload the page to see it.",
      });
      expect(mintCalls).toBe(0);
      expect(record("container.domain_skipped")).toMatchObject({ reason: "exists" });
    });

    it("refuses to expose a service it did not create", async () => {
      let mintCalls = 0;
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        api.mutation("ServiceDomainCreate", () => {
          mintCalls += 1;
          return HttpResponse.json({
            data: {
              serviceDomainCreate: { id: "dom_1", domain: "nope", targetPort: 80 },
            },
          });
        }),
      );

      const result = await generateDomain(null, actionForm("svc_foreign"));

      expect(result).toEqual({
        ok: false,
        error: "This service was not created here, so this app cannot act on it.",
      });
      expect(mintCalls).toBe(0);
      expect(record("container.domain_refused")).toMatchObject({
        reason: "unmanaged",
        service_id: "svc_foreign",
      });
    });

    it("reports a Railway refusal as a failure rather than a silent no-op", async () => {
      server.use(
        api.query("Project", () =>
          HttpResponse.json({
            data: projectWith([
              { id: "svc_managed", name: "spun-web", image: "nginx:alpine" },
            ]),
          }),
        ),
        api.mutation("ServiceDomainCreate", () =>
          HttpResponse.json({ errors: [{ message: "Not Authorized" }] }),
        ),
      );

      const result = await generateDomain(null, actionForm("svc_managed"));

      expect(result.ok).toBe(false);
    });
  });
});

describe("editContainer", () => {
  /**
   * The edit form as the dialog posts it.
   *
   * `projectWith()` describes `spun-cache` as running `redis:7-alpine`, so these defaults
   * are "nothing changed" — every case below overrides exactly the field it is about.
   */
  const editForm = (
    over: Record<string, string> = {},
    rows: Array<[string, string]> = [],
  ) => {
    const data = form({
      projectId: "p1",
      environmentId: "e1",
      serviceId: "svc_managed",
      name: "cache",
      image: "redis:7-alpine",
      ...over,
    });
    for (const [key, value] of rows) {
      data.append("variableKey", key);
      data.append("variableValue", value);
    }
    return data;
  };

  /** The service's own variables, as the two aliased reads answer them. */
  const variablesAre = (
    service: Record<string, string>,
    shared: Record<string, string> = {},
  ) =>
    api.query("ServiceVariables", () =>
      HttpResponse.json({ data: { service, shared } }),
    );

  it("refuses to edit a service it did not create", async () => {
    /*
     * The ADR-5 boundary, on the newest verb. Editing changes a container's description
     * rather than its running state, which makes it no less a change to infrastructure this
     * app may not own — and the guard is the same shared one, so this asserts that the verb
     * was routed through it at all.
     */
    let mutations = 0;
    server.use(
      api.query("Project", () => HttpResponse.json({ data: projectWith() })),
      api.mutation("ServiceUpdate", () => {
        mutations += 1;
        return HttpResponse.json({ data: { serviceUpdate: { id: "x", name: "y" } } });
      }),
    );

    const result = await editContainer(
      null,
      editForm({ serviceId: "svc_foreign", name: "hijacked" }),
    );

    expect(result).toEqual({
      ok: false,
      error: "This service was not created here, so this app cannot act on it.",
    });
    expect(mutations).toBe(0);
    expect(record("container.edit_refused")).toMatchObject({
      reason: "unmanaged",
      service_id: "svc_foreign",
    });
  });

  it("keeps the ownership prefix however the container is renamed", async () => {
    /*
     * The rename safety property, and the reason it needs no validation rule: `toManagedName`
     * always prefixes, so a name that has lost MANAGED_PREFIX is not a request shape. Posting
     * a name that tries to escape it produces a prefixed slug, not a refusal.
     */
    let sent: Record<string, unknown> | undefined;
    server.use(
      api.query("Project", () => HttpResponse.json({ data: projectWith() })),
      variablesAre({}),
      api.mutation("ServiceUpdate", ({ variables }) => {
        sent = variables.input as Record<string, unknown>;
        return HttpResponse.json({
          data: { serviceUpdate: { id: "svc_managed", name: "spun-escaped" } },
        });
      }),
    );

    const result = await editContainer(null, editForm({ name: "../../escaped" }));

    expect(sent).toEqual({ name: "spun-escaped" });
    expect(result).toEqual({ ok: true, message: "Updating escaped" });
  });

  it("refuses a rename onto a name another container already has", async () => {
    let mutations = 0;
    server.use(
      api.query("Project", () =>
        HttpResponse.json({
          data: projectWith([
            { id: "svc_managed", name: "spun-cache" },
            { id: "svc_other", name: "spun-taken" },
          ]),
        }),
      ),
      api.mutation("ServiceUpdate", () => {
        mutations += 1;
        return HttpResponse.json({ data: { serviceUpdate: { id: "x", name: "y" } } });
      }),
    );

    const result = await editContainer(null, editForm({ name: "taken" }));

    expect(result).toEqual({
      ok: false,
      field: "name",
      error: "A container named “taken” already exists here.",
    });
    expect(mutations).toBe(0);
    expect(record("container.edit_rejected")).toMatchObject({
      reason: "duplicate_name",
      service_name: "spun-taken",
    });
  });

  it("does not treat a container's own name as a collision", async () => {
    // The obvious way to get the duplicate check wrong: every edit posts the name it
    // already has, so a check that did not exclude the service itself would refuse them all.
    server.use(
      api.query("Project", () => HttpResponse.json({ data: projectWith() })),
      variablesAre({}),
      api.mutation("ServiceInstanceUpdate", () =>
        HttpResponse.json({ data: { serviceInstanceUpdate: true } }),
      ),
      api.mutation("ServiceInstanceDeployV2", () =>
        HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_new" } }),
      ),
    );

    const result = await editContainer(null, editForm({ image: "redis:8" }));

    expect(result).toEqual({ ok: true, message: "Updating cache" });
  });

  it("leaves an existing variable alone when its value cell is blank", async () => {
    /*
     * The rule the whole write-only design rests on. The form never shows a stored value, so
     * blank is what an untouched row looks like — and writing it back would erase every
     * variable the user did not retype. Reopening the editor on a database and pressing Save
     * must not roll its password.
     */
    let upsertCalls = 0;
    const deleted: string[] = [];
    server.use(
      api.query("Project", () => HttpResponse.json({ data: projectWith() })),
      variablesAre({ POSTGRES_PASSWORD: "hunter2" }),
      api.mutation("VariableCollectionUpsert", () => {
        upsertCalls += 1;
        return HttpResponse.json({ data: { variableCollectionUpsert: 1 } });
      }),
      api.mutation("VariableDelete", ({ variables }) => {
        deleted.push((variables.input as { name: string }).name);
        return HttpResponse.json({ data: { variableDelete: true } });
      }),
    );

    const result = await editContainer(null, editForm({}, [["POSTGRES_PASSWORD", ""]]));

    expect(upsertCalls).toBe(0);
    expect(deleted).toEqual([]);
    // Nothing changed at all, so nothing was redeployed either.
    expect(result).toEqual({ ok: true, message: "Nothing to change on cache." });
  });

  it("never re-mints a credential when the edit touches nothing new", async () => {
    /*
     * A regression, and the e2e found it before this did. `resolveVariables` reads an empty
     * submitted list as "no editor on the wire" — the pre-T-487 request shape — and answers
     * with the catalog's whole default set, minting every generated name in it. Correct on
     * spin-up; on an edit it rolled the password of a live database whenever someone saved a
     * form whose only change was elsewhere.
     *
     * Removing an unrelated row is the cheapest way to reach it: there is variable work to
     * do, and no *fresh* row to do it for.
     */
    let sent: Record<string, string> | undefined;
    server.use(
      api.query("Project", () => HttpResponse.json({ data: projectWith() })),
      variablesAre({ POSTGRES_PASSWORD: "hunter2", DROP: "x" }),
      api.mutation("VariableDelete", () =>
        HttpResponse.json({ data: { variableDelete: true } }),
      ),
      api.mutation("VariableCollectionUpsert", ({ variables }) => {
        sent = (variables.input as { variables: Record<string, string> }).variables;
        return HttpResponse.json({ data: { variableCollectionUpsert: 1 } });
      }),
      api.mutation("ServiceInstanceDeployV2", () =>
        HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_new" } }),
      ),
    );

    await editContainer(
      null,
      editForm({ image: "postgres:16-alpine" }, [["POSTGRES_PASSWORD", ""]]),
    );

    // Nothing was written at all: the only submitted row was blank and already existed.
    expect(sent).toBeUndefined();
  });

  it("writes an existing variable the user retyped", async () => {
    let sent: Record<string, string> | undefined;
    server.use(
      api.query("Project", () => HttpResponse.json({ data: projectWith() })),
      variablesAre({ POSTGRES_PASSWORD: "hunter2" }),
      api.mutation("VariableCollectionUpsert", ({ variables }) => {
        sent = (variables.input as { variables: Record<string, string> }).variables;
        return HttpResponse.json({ data: { variableCollectionUpsert: 1 } });
      }),
      api.mutation("ServiceInstanceDeployV2", () =>
        HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_new" } }),
      ),
    );

    const result = await editContainer(
      null,
      editForm({}, [["POSTGRES_PASSWORD", "newsecret"]]),
    );

    expect(sent).toEqual({ POSTGRES_PASSWORD: "newsecret" });
    expect(result).toEqual({ ok: true, message: "Updating cache" });
  });

  it("deletes a variable the editor no longer lists", async () => {
    const deleted: string[] = [];
    server.use(
      api.query("Project", () => HttpResponse.json({ data: projectWith() })),
      variablesAre({ KEEP: "a", DROP: "b" }),
      api.mutation("VariableDelete", ({ variables }) => {
        deleted.push((variables.input as { name: string }).name);
        return HttpResponse.json({ data: { variableDelete: true } });
      }),
      api.mutation("ServiceInstanceDeployV2", () =>
        HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_new" } }),
      ),
    );

    await editContainer(null, editForm({}, [["KEEP", ""]]));

    expect(deleted).toEqual(["DROP"]);
  });

  it("does not offer to delete a variable the environment shares", async () => {
    /*
     * A shared variable is not the service's to remove, and `variableDelete` scoped to a
     * service could not remove it anyway — so it must never reach the editor and therefore
     * must never be missing from what the editor posts back.
     */
    const deleted: string[] = [];
    server.use(
      api.query("Project", () => HttpResponse.json({ data: projectWith() })),
      variablesAre({ OWN: "a", SHARED_TOKEN: "s" }, { SHARED_TOKEN: "s" }),
      api.mutation("VariableDelete", ({ variables }) => {
        deleted.push((variables.input as { name: string }).name);
        return HttpResponse.json({ data: { variableDelete: true } });
      }),
      api.mutation("ServiceInstanceDeployV2", () =>
        HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_new" } }),
      ),
    );

    await editContainer(null, editForm({}, [["OWN", ""]]));

    expect(deleted).toEqual([]);
  });

  it("mints a credential for a new catalog row left blank, and says where to read it", async () => {
    /*
     * The same authority bound spin-up has, on the edit path: a blank value mints only when
     * the name is one the CATALOG declares generated for the submitted image, and only when
     * the variable is new. "Generate me a secret" is still not a request shape.
     */
    let sent: Record<string, string> | undefined;
    server.use(
      api.query("Project", () => HttpResponse.json({ data: projectWith() })),
      variablesAre({}),
      api.mutation("ServiceInstanceUpdate", () =>
        HttpResponse.json({ data: { serviceInstanceUpdate: true } }),
      ),
      api.mutation("VariableCollectionUpsert", ({ variables }) => {
        sent = (variables.input as { variables: Record<string, string> }).variables;
        return HttpResponse.json({ data: { variableCollectionUpsert: 1 } });
      }),
      api.mutation("ServiceInstanceDeployV2", () =>
        HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_new" } }),
      ),
    );

    const result = await editContainer(
      null,
      editForm({ image: "postgres:16-alpine" }, [["POSTGRES_PASSWORD", ""]]),
    );

    expect(sent?.POSTGRES_PASSWORD).toMatch(/^[\w-]{20,}$/);
    expect(result).toEqual({
      ok: true,
      message:
        "Updating cache. Its generated credentials are on Railway, under this service's Variables.",
    });
    // The one thing that must never be true of a minted value.
    expect(rawLogLines().join("\n")).not.toContain(sent?.POSTGRES_PASSWORD ?? "!");
  });

  it("records what the container used to be, and no variable value", async () => {
    server.use(
      api.query("Project", () => HttpResponse.json({ data: projectWith() })),
      variablesAre({}),
      api.mutation("ServiceUpdate", () =>
        HttpResponse.json({
          data: { serviceUpdate: { id: "svc_managed", name: "spun-renamed" } },
        }),
      ),
      api.mutation("ServiceInstanceUpdate", () =>
        HttpResponse.json({ data: { serviceInstanceUpdate: true } }),
      ),
      api.mutation("VariableCollectionUpsert", () =>
        HttpResponse.json({ data: { variableCollectionUpsert: 1 } }),
      ),
      api.mutation("ServiceInstanceDeployV2", () =>
        HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_new" } }),
      ),
    );

    await editContainer(
      null,
      editForm({ name: "renamed", image: "postgres:17" }, [["MY_SECRET", "hunter2"]]),
    );

    /*
     * Railway keeps no history of a service's previous name or image, so this line is the
     * only record anywhere that the container used to be something else.
     */
    expect(record("container.updated")).toMatchObject({
      service_name: "spun-renamed",
      previous_name: "spun-cache",
      image: "postgres:17",
      previous_image: "redis:7-alpine",
      deployment_id: "dep_new",
      outcome: "deployed",
      // A user-chosen name is unbounded, so it is counted rather than named.
      variable_names: "",
      user_variable_count: 1,
    });
    expect(rawLogLines().join("\n")).not.toContain("hunter2");
    expect(rawLogLines().join("\n")).not.toContain("MY_SECRET");
  });

  it("attributes a bad variable row to its cell so the form can point at it", async () => {
    // Shape is refused before the ownership read: a typo costs no Railway round trip, and
    // `onUnhandledRequest: "error"` is what asserts that no request was made.
    const result = await editContainer(null, editForm({}, [["lower case", "x"]]));

    expect(result).toMatchObject({
      ok: false,
      field: "variableKey",
      index: 0,
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
