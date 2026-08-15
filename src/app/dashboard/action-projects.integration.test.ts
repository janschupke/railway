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
import { form, record } from "@/test/dashboard-fixtures";

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

const { createProject, createEnvironment } = await import("./actions");
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
 * Creating a project and creating an environment.
 *
 * Split from actions.integration.test.ts along the same seam the source module was, so a
 * verb's cases sit beside the module that implements it.
 */

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
     *
     * `workspaceId` is absent rather than null, and this exact assertion is what says so:
     * Railway reads an absent workspace as the personal account, and a null would be this
     * app asserting something about a member it was not told anything about.
     */
    expect(sent[0]?.input).toEqual({ name: "Client work" });
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard");
  });

  it("creates the project in the workspace that was chosen", async () => {
    const sent: Array<Record<string, unknown>> = [];
    server.use(
      api.mutation("ProjectCreate", ({ variables }) => {
        sent.push(variables);
        return HttpResponse.json(created());
      }),
    );

    const result = await createProject(
      null,
      form({ projectName: "Client work", workspaceId: "ws_1" }),
    );

    expect(result.ok).toBe(true);
    expect(sent[0]?.input).toEqual({ name: "Client work", workspaceId: "ws_1" });
  });

  it("reads the personal option's blank value as no workspace at all", async () => {
    // What the select actually posts for "Personal account". It must reach Railway as an
    // omitted member, not as an empty string it would have to interpret.
    const sent: Array<Record<string, unknown>> = [];
    server.use(
      api.mutation("ProjectCreate", ({ variables }) => {
        sent.push(variables);
        return HttpResponse.json(created());
      }),
    );

    await createProject(null, form({ projectName: "Client work", workspaceId: "" }));

    expect(sent[0]?.input).toEqual({ name: "Client work" });
  });

  it("toasts rather than points at a field when the workspace id is not one", async () => {
    /*
     * Nothing on screen to attribute it to: the workspace is a select drawn from a list
     * Railway gave this app, so the only way to reach this is a stale page. `workspaceId`
     * is not an ActionField, which is what sends the sentence to a toast instead.
     */
    const result = await createProject(
      null,
      form({ projectName: "Client work", workspaceId: "ws/1" }),
    );

    expect(result).toEqual({
      ok: false,
      error:
        "That reference is not one Railway could have issued. Reload the page and try again.",
    });
  });

  it("records the creation of billable infrastructure, and where it went", async () => {
    server.use(api.mutation("ProjectCreate", () => HttpResponse.json(created())));

    await createProject(
      null,
      form({ projectName: "Client work", workspaceId: "ws_1" }),
    );

    expect(record("project.created")).toMatchObject({
      project_id: "proj_new",
      project_name: "Client work",
      environment_count: 1,
      workspace_id: "ws_1",
    });
  });

  it("records a personal project as one, rather than as a missing field", async () => {
    server.use(api.mutation("ProjectCreate", () => HttpResponse.json(created())));

    await createProject(null, form({ projectName: "Client work" }));

    // Null, not absent. This is the only record of where a project ended up — the app
    // cannot move it afterwards — so "personal" and "unlogged" must not read alike.
    expect(record("project.created")).toMatchObject({ workspace_id: null });
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
