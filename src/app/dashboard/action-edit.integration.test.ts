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
import { projectWith, form, record } from "@/test/dashboard-fixtures";

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

const { editContainer } = await import("./actions");
const { __resetIdempotency } = await import("@/lib/idempotency");

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
 * Changing a container's name, image and variables.
 *
 * Split from actions.integration.test.ts along the same seam the source module was, so a
 * verb's cases sit beside the module that implements it.
 */

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
