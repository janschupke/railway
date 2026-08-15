import { HttpResponse, graphql } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { LIST, STREAM } from "@/lib/constants";
import { logRecords, rawLogLines } from "@/test/log-capture";
import {
  createContainer,
  createServiceDomain,
  deleteVolume,
  destroyContainer,
  getEnvironmentVolumes,
  getProjectContainers,
  getProjectMetrics,
  listProjects,
  listServiceDeployments,
  readServiceVariableNames,
  rollbackDeployment,
  updateContainer,
} from "./api";
import { getDeployment, getDeploymentFailure, getLogs } from "./deployment-reads";
import { railwayApiUrl } from "./client";

const api = graphql.link(railwayApiUrl());
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const TOKEN = "token";

/**
 * Railway answering `volumeCreate`.
 *
 * Written once because it is now part of creating most of the interesting presets: redis,
 * postgres, mysql, mariadb, mongo and rabbitmq all attach a volume before they deploy, so a
 * create test using one of them that does NOT stub this is testing the volume_failed branch
 * by accident. `onCall` is for the tests that care where in the sequence it lands.
 */
const volumeOk = (onCall?: (input: Record<string, unknown>) => void) =>
  api.mutation("VolumeCreate", ({ variables }) => {
    onCall?.(variables.input as Record<string, unknown>);
    return HttpResponse.json({
      data: { volumeCreate: { id: "vol_1", name: "spun-db-volume" } },
    });
  });

/** A project node as Railway nests it, so the connection shape is written once. */
const node = (id: string, name: string) => ({
  id,
  name,
  environments: { edges: [{ node: { id: "e1", name: "production" } }] },
});

describe("listProjects", () => {
  /** The two documents the project list is assembled from, with usable defaults. */
  const sources = ({
    viewer = { id: "u1", name: "Ada", email: "ada@example.com" },
    personal = [] as ReturnType<typeof node>[],
    workspaces = [] as Array<{ id: string; name: string; projects: unknown[] }>,
  } = {}) => [
    api.query("ProjectsPersonal", () =>
      HttpResponse.json({
        data: {
          me: {
            ...viewer,
            projects: { edges: personal.map((n) => ({ node: n })) },
          },
        },
      }),
    ),
    api.query("ProjectsWorkspace", () =>
      HttpResponse.json({
        data: {
          me: {
            id: "u1",
            workspaces: workspaces.map((w) => ({
              id: w.id,
              name: w.name,
              projects: { edges: w.projects.map((n) => ({ node: n })) },
            })),
          },
        },
      }),
    ),
  ];

  /**
   * Railway's real refusal shape: HTTP 200, `Not Authorized`, and INTERNAL_SERVER_ERROR
   * rather than any code the spec suggests. Returned as a body so each resolver keeps
   * MSW's contextual typing.
   */
  const notAuthorized = (path: string[]) => ({
    errors: [
      {
        message: "Not Authorized",
        path,
        extensions: { code: "INTERNAL_SERVER_ERROR" },
      },
    ],
  });

  it("flattens the viewer and their projects out of Relay connections", async () => {
    server.use(...sources({ personal: [node("p1", "Demo")] }));

    const { viewer, projects } = await listProjects(TOKEN);

    expect(viewer).toEqual({ id: "u1", name: "Ada", email: "ada@example.com" });
    expect(projects).toEqual([
      { id: "p1", name: "Demo", environments: [{ id: "e1", name: "production" }] },
    ]);
  });

  it("copes with a user who has no projects", async () => {
    server.use(...sources());

    const { projects, failures } = await listProjects(TOKEN);
    expect(projects).toEqual([]);
    expect(failures).toEqual([]);
  });

  it("finds projects that hang off a workspace rather than the viewer", async () => {
    /*
     * The bug this exists to stop: `me.projects` came back empty, the dashboard said
     * "no projects shared", and the only offered action was a consent screen that had
     * already granted everything.
     */
    server.use(
      ...sources({
        workspaces: [{ id: "ws1", name: "Acme", projects: [node("p1", "Demo")] }],
      }),
    );

    expect((await listProjects(TOKEN)).projects).toEqual([
      {
        id: "p1",
        name: "Demo",
        environments: [{ id: "e1", name: "production" }],
        workspaceName: "Acme",
      },
    ]);
  });

  it("returns the workspaces themselves, including ones holding no projects", async () => {
    /*
     * The create dialog's list, and why it cannot be derived from the projects: an empty
     * workspace is still somewhere a project can be created, and `toProjects` can only
     * ever name a workspace that already had something in it.
     */
    server.use(
      ...sources({
        workspaces: [
          { id: "ws1", name: "Acme", projects: [node("p1", "Demo")] },
          { id: "ws2", name: "Beta", projects: [] },
        ],
      }),
    );

    expect((await listProjects(TOKEN)).workspaces).toEqual([
      { id: "ws1", name: "Acme" },
      { id: "ws2", name: "Beta" },
    ]);
  });

  it("has no workspaces to offer when that source was refused", async () => {
    // A token with `project:admin` and no `workspace:viewer`. The personal list is intact
    // and the workspace one is empty, which is the state the dialog explains rather than
    // silently drawing a control with nothing in it.
    server.use(
      ...sources({ personal: [node("p1", "Demo")] }).slice(0, 1),
      api.query("ProjectsWorkspace", () =>
        HttpResponse.json(notAuthorized(["me", "workspaces"])),
      ),
    );

    const { projects, workspaces } = await listProjects(TOKEN);
    expect(projects).toHaveLength(1);
    expect(workspaces).toEqual([]);
  });

  it("shows a project reachable through both connections exactly once", async () => {
    server.use(
      ...sources({
        personal: [node("p1", "Demo")],
        workspaces: [
          {
            id: "ws1",
            name: "Acme",
            projects: [node("p1", "Demo"), node("p2", "Other")],
          },
        ],
      }),
    );

    const { projects } = await listProjects(TOKEN);

    expect(projects.map((p) => p.id)).toEqual(["p1", "p2"]);
    // The personal entry wins, so a project the user owns is not labelled with a team.
    expect(projects[0]?.workspaceName).toBeUndefined();
    expect(projects[1]?.workspaceName).toBe("Acme");
  });

  it("keeps the projects that answered when one source is refused", async () => {
    /*
     * THE regression. An OAuth token without a workspace scope makes Railway refuse
     * `me.workspaces`, and refusing one field used to discard the whole response — so a
     * personal project list that had arrived perfectly intact was thrown away and the
     * dashboard showed "Railway rejected the operation" on every single load.
     */
    server.use(
      // Personal only — the workspace handler is the refusal below, not the default.
      ...sources({ personal: [node("p1", "Demo")] }).slice(0, 1),
      api.query("ProjectsWorkspace", () =>
        HttpResponse.json(notAuthorized(["me", "workspaces"])),
      ),
    );

    const { projects, failures } = await listProjects(TOKEN);

    expect(projects.map((p) => p.id)).toEqual(["p1"]);
    // Reported rather than swallowed: the list is real but incomplete, and the sentence
    // has to name the scope that would complete it.
    expect(failures).toHaveLength(1);
    expect(failures[0]?.kind).toBe("auth");
    expect(failures[0]?.missingScope).toBe("workspace:viewer");
  });

  it("takes identity from the personal document rather than a request of its own", async () => {
    // The whole reason the separate Viewer query could go: these three scalars were one
    // selection away from a document already being issued.
    server.use(...sources({ personal: [node("p1", "Demo")] }));

    const { viewer } = await listProjects(TOKEN);

    expect(viewer).toEqual({ id: "u1", name: "Ada", email: "ada@example.com" });
  });

  it("degrades to a nameless viewer when only the workspace source answers", async () => {
    /*
     * name and email now ride on the personal document, so a token refused it loses
     * them. That is a nameless header, not an empty dashboard: both fields are optional
     * on ViewerNode and the workspace source still carries the id.
     */
    server.use(
      api.query("ProjectsPersonal", () =>
        HttpResponse.json(notAuthorized(["me", "projects"])),
      ),
      ...sources({
        workspaces: [{ id: "w1", name: "Acme", projects: [node("p2", "Team")] }],
      }).slice(1),
    );

    const { viewer, projects } = await listProjects(TOKEN);

    expect(viewer.id).toBe("u1");
    expect(viewer.name).toBeUndefined();
    expect(projects.map((p) => p.id)).toEqual(["p2"]);
  });

  it("fails with the authorization cause when every source is refused", async () => {
    server.use(
      api.query("ProjectsPersonal", () =>
        HttpResponse.json(notAuthorized(["me", "projects"])),
      ),
      api.query("ProjectsWorkspace", () =>
        HttpResponse.json(notAuthorized(["me", "workspaces"])),
      ),
    );

    const error = (await listProjects(TOKEN).catch((e: unknown) => e)) as {
      kind: string;
    };
    // Not "graphql": Railway's refusal wording is the only signal it gives, and getting
    // this wrong is what offered a Retry instead of a re-authorize.
    expect(error.kind).toBe("auth");
  });
});

describe("getProjectContainers", () => {
  const project = (services: unknown[]) => ({
    data: {
      project: {
        id: "p1",
        name: "Demo",
        environments: { edges: [{ node: { id: "e1", name: "production" } }] },
        services: { edges: services },
      },
    },
  });

  const service = (id: string, name: string, environmentId = "e1") => ({
    node: {
      id,
      name,
      createdAt: "2026-08-01T00:00:00Z",
      serviceInstances: {
        edges: [
          {
            node: {
              id: `si_${id}`,
              environmentId,
              source: { image: "redis:7-alpine", repo: null },
              latestDeployment: {
                id: `dep_${id}`,
                status: "SUCCESS",
                createdAt: "2026-08-01T00:00:00Z",
                updatedAt: "2026-08-01T00:01:00Z",
              },
            },
          },
        ],
      },
    },
  });

  it("returns the project and its containers for one environment", async () => {
    server.use(
      api.query("Project", () =>
        HttpResponse.json(project([service("s1", "spun-cache")])),
      ),
    );

    const { project: p, containers } = await getProjectContainers(TOKEN, "p1", "e1");

    expect(p.name).toBe("Demo");
    expect(containers).toHaveLength(1);
    expect(containers[0]).toMatchObject({ displayName: "cache", managed: true });
  });

  it("hides services that live in another environment", async () => {
    server.use(
      api.query("Project", () =>
        HttpResponse.json(project([service("s1", "spun-cache", "e2")])),
      ),
    );

    expect((await getProjectContainers(TOKEN, "p1", "e1")).containers).toEqual([]);
  });
});

describe("createContainer", () => {
  it("creates then deploys, returning the deployment to stream", async () => {
    server.use(
      api.mutation("ServiceCreate", () =>
        HttpResponse.json({ data: { serviceCreate: { id: "svc_1", name: "spun-x" } } }),
      ),
      volumeOk(),
      api.mutation("ServiceInstanceDeployV2", () =>
        HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_1" } }),
      ),
    );

    const result = await createContainer(TOKEN, {
      projectId: "p1",
      environmentId: "e1",
      name: "spun-x",
      image: "redis:7-alpine",
    });

    expect(result).toEqual({
      serviceId: "svc_1",
      deploymentId: "dep_1",
      url: null,
      outcome: "deployed",
    });
  });

  it("sets the environment before deploying, not after", async () => {
    /*
     * Order is the whole point. A postgres container started without POSTGRES_PASSWORD
     * exits on its first tick and Railway restarts it forever; setting the variables
     * afterwards would need a redeploy and would show that crash loop first.
     */
    const calls: string[] = [];
    server.use(
      api.mutation("ServiceCreate", () => {
        calls.push("create");
        return HttpResponse.json({
          data: { serviceCreate: { id: "svc_1", name: "spun-db" } },
        });
      }),
      volumeOk(() => calls.push("volume")),
      api.mutation("VariableCollectionUpsert", () => {
        calls.push("variables");
        return HttpResponse.json({ data: { variableCollectionUpsert: 1 } });
      }),
      api.mutation("ServiceInstanceDeployV2", () => {
        calls.push("deploy");
        return HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_1" } });
      }),
    );

    const result = await createContainer(TOKEN, {
      projectId: "p1",
      environmentId: "e1",
      name: "spun-db",
      image: "postgres:16-alpine",
      variables: { POSTGRES_PASSWORD: "generated" },
    });

    expect(calls).toEqual(["create", "volume", "variables", "deploy"]);
    expect(result.outcome).toBe("deployed");
  });

  it("asks Railway not to deploy on the variable change", async () => {
    /*
     * The deploy below returns the deployment id the row's log stream keys on. Railway
     * redeploys a service when its variables change, so without `skipDeploys` there is a
     * second deployment whose id this app never learns — and the row streams logs from a
     * deployment that is not the one it just started.
     *
     * `replace: false` is the other half: the mutation can wipe a service's existing
     * variables, and that is the wrong default to leave lying around in a call this app
     * makes on every spin-up.
     */
    let sent: Record<string, unknown> | undefined;
    server.use(
      api.mutation("ServiceCreate", () =>
        HttpResponse.json({
          data: { serviceCreate: { id: "svc_1", name: "spun-db" } },
        }),
      ),
      volumeOk(),
      api.mutation("VariableCollectionUpsert", ({ variables }) => {
        sent = variables.input as Record<string, unknown>;
        return HttpResponse.json({ data: { variableCollectionUpsert: 1 } });
      }),
      api.mutation("ServiceInstanceDeployV2", () =>
        HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_1" } }),
      ),
    );

    await createContainer(TOKEN, {
      projectId: "p1",
      environmentId: "e1",
      name: "spun-db",
      image: "postgres:16-alpine",
      variables: { POSTGRES_PASSWORD: "generated" },
    });

    expect(sent).toMatchObject({
      projectId: "p1",
      environmentId: "e1",
      serviceId: "svc_1",
      replace: false,
      skipDeploys: true,
    });
  });

  it("declines to deploy a service whose environment could not be set", async () => {
    /*
     * The service exists, is prefixed, and is destroyable from the dashboard. That is
     * strictly better than a running container in a restart loop nobody can diagnose —
     * the same reasoning as the un-deployed case above.
     */
    server.use(
      api.mutation("ServiceCreate", () =>
        HttpResponse.json({
          data: { serviceCreate: { id: "svc_1", name: "spun-db" } },
        }),
      ),
      volumeOk(),
      api.mutation("VariableCollectionUpsert", () =>
        HttpResponse.json({ errors: [{ message: "Not Authorized" }] }),
      ),
      api.mutation("ServiceInstanceDeployV2", () => {
        throw new Error("must not deploy an unconfigured service");
      }),
    );

    const result = await createContainer(TOKEN, {
      projectId: "p1",
      environmentId: "e1",
      name: "spun-db",
      image: "postgres:16-alpine",
      variables: { POSTGRES_PASSWORD: "generated" },
    });

    expect(result).toEqual({
      serviceId: "svc_1",
      deploymentId: null,
      url: null,
      outcome: "variables_failed",
    });
  });

  it("reports the service when the deploy is refused, rather than throwing it away", async () => {
    /*
     * The regression T-471 names. A throw here carries no service id, so the caller could
     * not tell "nothing was created" from "a billable service exists and is not running",
     * and the audit line that says who created what never ran at all.
     */
    server.use(
      api.mutation("ServiceCreate", () =>
        HttpResponse.json({ data: { serviceCreate: { id: "svc_1", name: "spun-x" } } }),
      ),
      volumeOk(),
      api.mutation("ServiceInstanceDeployV2", () =>
        HttpResponse.json({ errors: [{ message: "Not Authorized" }] }),
      ),
    );

    const result = await createContainer(TOKEN, {
      projectId: "p1",
      environmentId: "e1",
      name: "spun-x",
      image: "redis:7-alpine",
    });

    expect(result).toEqual({
      serviceId: "svc_1",
      deploymentId: null,
      url: null,
      outcome: "deploy_failed",
    });

    // The classification the user's sentence no longer carries has to survive somewhere,
    // and this record — incident id included — is where.
    const failure = logRecords().find((r) => r.msg === "railway.deploy_failed");
    expect(failure).toMatchObject({ service_id: "svc_1" });
    expect(failure?.err).toMatchObject({
      type: "RailwayApiError",
      operation: "ServiceInstanceDeployV2",
      incident: expect.stringMatching(/^[0-9a-f]{8}$/) as unknown as string,
    });
  });

  it("issues neither a variables nor a volume call for an image that boots bare", async () => {
    /*
     * nginx rather than redis, and the swap is the point rather than a detail. redis used to
     * be the bare image here; since T-491 it keeps state, so it takes a volume — and this
     * test would have been asserting the absence of a call the app now correctly makes.
     *
     * Both absences matter, and for the same reason: this app does not know where an
     * arbitrary image writes, so a volume attached anyway would be billable storage that
     * stays empty while the data still vanishes.
     */
    server.use(
      api.mutation("ServiceCreate", () =>
        HttpResponse.json({ data: { serviceCreate: { id: "svc_1", name: "spun-x" } } }),
      ),
      api.mutation("VariableCollectionUpsert", () => {
        throw new Error("no variables should be sent");
      }),
      api.mutation("VolumeCreate", () => {
        throw new Error("no volume should be attached to an image with no preset");
      }),
      api.mutation("ServiceInstanceDeployV2", () =>
        HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_1" } }),
      ),
    );

    await expect(
      createContainer(TOKEN, {
        projectId: "p1",
        environmentId: "e1",
        name: "spun-x",
        image: "nginx:alpine",
      }),
    ).resolves.toMatchObject({ outcome: "deployed" });
  });

  it("still reports the service when the deploy returns no id", async () => {
    // The service exists either way; the dashboard shows it as un-deployed rather
    // than silently orphaning it.
    server.use(
      api.mutation("ServiceCreate", () =>
        HttpResponse.json({ data: { serviceCreate: { id: "svc_1", name: "spun-x" } } }),
      ),
      volumeOk(),
      api.mutation("ServiceInstanceDeployV2", () =>
        HttpResponse.json({ data: { serviceInstanceDeployV2: null } }),
      ),
    );

    const result = await createContainer(TOKEN, {
      projectId: "p1",
      environmentId: "e1",
      name: "spun-x",
      image: "redis:7-alpine",
    });

    expect(result).toEqual({
      serviceId: "svc_1",
      deploymentId: null,
      url: null,
      outcome: "deployed",
    });
  });
});

describe("createContainer, attaching a volume", () => {
  it("sends the catalog's mount path, scoped to one environment", async () => {
    /*
     * `environmentId` is the field to watch. Railway's own description says an ABSENT
     * environmentId deploys the volume to every environment in the project — so omitting
     * it for a service that lives in one would provision billable storage in all of them.
     */
    let sent: Record<string, unknown> | undefined;
    server.use(
      api.mutation("ServiceCreate", () =>
        HttpResponse.json({
          data: { serviceCreate: { id: "svc_1", name: "spun-db" } },
        }),
      ),
      volumeOk((input) => {
        sent = input;
      }),
      api.mutation("VariableCollectionUpsert", () =>
        HttpResponse.json({ data: { variableCollectionUpsert: 1 } }),
      ),
      api.mutation("ServiceInstanceDeployV2", () =>
        HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_1" } }),
      ),
    );

    await createContainer(TOKEN, {
      projectId: "p1",
      environmentId: "e1",
      name: "spun-db",
      image: "postgres:16-alpine",
      variables: { POSTGRES_PASSWORD: "generated" },
    });

    expect(sent).toEqual({
      projectId: "p1",
      environmentId: "e1",
      serviceId: "svc_1",
      mountPath: "/var/lib/postgresql/data",
    });
  });

  it("matches the mount path on the repository, so a different tag still gets one", async () => {
    let sent: Record<string, unknown> | undefined;
    server.use(
      api.mutation("ServiceCreate", () =>
        HttpResponse.json({
          data: { serviceCreate: { id: "svc_1", name: "spun-db" } },
        }),
      ),
      volumeOk((input) => {
        sent = input;
      }),
      api.mutation("ServiceInstanceDeployV2", () =>
        HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_1" } }),
      ),
    );

    await createContainer(TOKEN, {
      projectId: "p1",
      environmentId: "e1",
      name: "spun-cache",
      image: "redis:8",
    });

    expect(sent).toMatchObject({ mountPath: "/data" });
  });

  it("declines to deploy a stateful service whose volume was refused", async () => {
    /*
     * The branch T-491 exists for, and the one place where NOT deploying is the feature.
     * A database that came up here would look healthy, accept writes, and lose every one of
     * them the next time the container moved — which is exactly the defect being fixed. An
     * un-deployed service is visible, prefixed and destroyable instead.
     */
    server.use(
      api.mutation("ServiceCreate", () =>
        HttpResponse.json({
          data: { serviceCreate: { id: "svc_1", name: "spun-db" } },
        }),
      ),
      api.mutation("VolumeCreate", () =>
        HttpResponse.json({ errors: [{ message: "Not Authorized" }] }),
      ),
      api.mutation("VariableCollectionUpsert", () => {
        throw new Error("must not configure a service it will not deploy");
      }),
      api.mutation("ServiceInstanceDeployV2", () => {
        throw new Error("must not deploy a stateful service with no volume");
      }),
    );

    const result = await createContainer(TOKEN, {
      projectId: "p1",
      environmentId: "e1",
      name: "spun-db",
      image: "postgres:16-alpine",
      variables: { POSTGRES_PASSWORD: "generated" },
    });

    expect(result).toEqual({
      serviceId: "svc_1",
      deploymentId: null,
      url: null,
      outcome: "volume_failed",
    });

    const failure = logRecords().find((r) => r.msg === "railway.volume_failed");
    expect(failure).toMatchObject({
      service_id: "svc_1",
      mount_path: "/var/lib/postgresql/data",
    });
  });

  it("records the name Railway derived, because that is what carries the prefix", async () => {
    /*
     * This app sends no name and never renames the volume. Railway derives one from the
     * service — `spun-db` gets `spun-db-volume` — which is how the MANAGED_PREFIX reaches
     * the volume for free, and is why `volumeUpdate` sits in OPTIONAL_FIELDS rather than
     * being a document. The record is what would show that behaviour changing.
     */
    server.use(
      api.mutation("ServiceCreate", () =>
        HttpResponse.json({
          data: { serviceCreate: { id: "svc_1", name: "spun-db" } },
        }),
      ),
      volumeOk(),
      api.mutation("ServiceInstanceDeployV2", () =>
        HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_1" } }),
      ),
    );

    await createContainer(TOKEN, {
      projectId: "p1",
      environmentId: "e1",
      name: "spun-db",
      image: "mongo:7",
    });

    expect(logRecords().find((r) => r.msg === "railway.volume_created")).toMatchObject({
      service_id: "svc_1",
      volume_id: "vol_1",
      volume_name: "spun-db-volume",
      mount_path: "/data/db",
    });
  });
});

describe("createContainer, applying the advanced resource controls", () => {
  /*
   * The four calls every case here needs, with the operation sequence recorded.
   *
   * The capture callbacks are on the stub rather than passed as a second `server.use`
   * handler for the same operation, because MSW answers with the first match — an override
   * registered after this one never runs, and the assertion silently reads `undefined`.
   * Same shape `volumeOk` above uses, for the same reason.
   */
  const stubs = (
    calls: string[],
    over: {
      settingsFail?: boolean;
      limitsFail?: boolean;
      onSettings?: (variables: Record<string, unknown>) => void;
      onLimits?: (input: Record<string, unknown>) => void;
    } = {},
  ) => [
    api.mutation("ServiceCreate", () => {
      calls.push("create");
      return HttpResponse.json({
        data: { serviceCreate: { id: "svc_1", name: "spun-x" } },
      });
    }),
    api.mutation("ServiceInstanceUpdate", ({ variables }) => {
      calls.push("settings");
      over.onSettings?.(variables as Record<string, unknown>);
      return over.settingsFail
        ? HttpResponse.json({ errors: [{ message: "refused" }] }, { status: 200 })
        : HttpResponse.json({ data: { serviceInstanceUpdate: true } });
    }),
    api.mutation("ServiceInstanceLimitsUpdate", ({ variables }) => {
      calls.push("limits");
      over.onLimits?.((variables as { input: Record<string, unknown> }).input);
      return over.limitsFail
        ? HttpResponse.json({ errors: [{ message: "refused" }] }, { status: 200 })
        : HttpResponse.json({ data: { serviceInstanceLimitsUpdate: true } });
    }),
    api.mutation("ServiceInstanceDeployV2", () => {
      calls.push("deploy");
      return HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_1" } });
    }),
  ];

  const create = (params: Record<string, unknown> = {}) =>
    createContainer(TOKEN, {
      projectId: "p1",
      environmentId: "e1",
      name: "spun-x",
      image: "nginx:1.27-alpine",
      ...params,
    });

  /*
   * The guarantee the whole design turns on: adding seven optional controls costs a spin-up
   * that used none of them exactly nothing. `onUnhandledRequest: "error"` is what makes the
   * absence an assertion rather than a claim — a request to either new mutation fails the
   * test with no handler to answer it.
   */
  it("issues no extra request when nothing was asked for", async () => {
    const calls: string[] = [];
    server.use(...stubs(calls));

    await create({ settings: {}, limits: {} });

    expect(calls).toEqual(["create", "deploy"]);
  });

  it("issues no extra request when the caller passes neither object", async () => {
    const calls: string[] = [];
    server.use(...stubs(calls));

    await create();

    expect(calls).toEqual(["create", "deploy"]);
  });

  /*
   * Settings before the volume, which is the ordering `region` fixes: a volume is
   * provisioned for the service as it stands, so a region applied afterwards is applied to a
   * service whose storage was already placed, and this app cannot move it.
   */
  it("applies the settings before the volume and before the deploy", async () => {
    const calls: string[] = [];
    server.use(
      ...stubs(calls),
      volumeOk(() => calls.push("volume")),
      api.mutation("VariableCollectionUpsert", () => {
        calls.push("variables");
        return HttpResponse.json({ data: { variableCollectionUpsert: 1 } });
      }),
    );

    await create({
      image: "postgres:16-alpine",
      variables: { POSTGRES_PASSWORD: "x" },
      settings: { region: "us-west2" },
      limits: { cpu: 0.5 },
    });

    expect(calls).toEqual([
      "create",
      "settings",
      "limits",
      "volume",
      "variables",
      "deploy",
    ]);
  });

  it("sends only the members that were asked for", async () => {
    const calls: string[] = [];
    let sent: Record<string, unknown> | undefined;
    server.use(...stubs(calls, { onSettings: (variables) => (sent = variables) }));

    await create({ settings: { replicas: 3 } });

    expect(sent).toMatchObject({
      serviceId: "svc_1",
      // Always sent: an omitted environment updates the service in every non-fork
      // environment, which is a blast radius nobody asked for from a form naming one.
      environmentId: "e1",
      input: { numReplicas: 3 },
    });
    expect(Object.keys((sent?.input ?? {}) as object)).toEqual(["numReplicas"]);
  });

  it("maps every setting onto the member Railway names it", async () => {
    const calls: string[] = [];
    let input: Record<string, unknown> | undefined;
    server.use(
      ...stubs(calls, {
        onSettings: (variables) =>
          (input = (variables as { input: Record<string, unknown> }).input),
      }),
    );

    await create({
      settings: {
        region: "us-west2",
        replicas: 2,
        restartPolicy: "ON_FAILURE",
        restartRetries: 4,
        startCommand: "serve",
      },
    });

    expect(input).toEqual({
      region: "us-west2",
      numReplicas: 2,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 4,
      startCommand: "serve",
    });
  });

  it("sends CPU and memory to their own mutation, and only when asked", async () => {
    const calls: string[] = [];
    let input: Record<string, unknown> | undefined;
    server.use(...stubs(calls, { onLimits: (sent) => (input = sent) }));

    await create({ limits: { cpu: 0.5, memory: 2 } });

    expect(calls).toEqual(["create", "limits", "deploy"]);
    expect(input).toEqual({
      environmentId: "e1",
      serviceId: "svc_1",
      vCPUs: 0.5,
      memoryGB: 2,
    });
  });

  /*
   * A refusal does not deploy, on the argument the volume and variables branches make: a
   * container running in a region nobody asked for is a container quietly not doing what the
   * form said it would, and an un-deployed service is visible, prefixed and destroyable.
   */
  it("stops before the deploy when the settings are refused", async () => {
    const calls: string[] = [];
    server.use(...stubs(calls, { settingsFail: true }));

    const result = await create({ settings: { replicas: 3, startCommand: "serve" } });

    expect(result).toEqual({
      serviceId: "svc_1",
      deploymentId: null,
      url: null,
      outcome: "settings_failed",
    });
    expect(calls).toEqual(["create", "settings"]);
  });

  it("stops before the deploy when the size is refused, which is usually the plan", async () => {
    const calls: string[] = [];
    server.use(...stubs(calls, { limitsFail: true }));

    const result = await create({ limits: { cpu: 32 } });

    expect(result.outcome).toBe("limits_failed");
    expect(calls).toEqual(["create", "limits"]);
  });

  /*
   * The start command is the one free-text field on the panel, so it is counted rather than
   * named — the split `container.created` already makes between preset variable names and a
   * count of the user's. Everything else here is closed or bounded and is named.
   */
  it("records the length of the start command and never the command", async () => {
    const calls: string[] = [];
    server.use(...stubs(calls, { settingsFail: true }));

    await create({
      settings: {
        region: "us-west2",
        replicas: 3,
        restartPolicy: "ALWAYS",
        startCommand: "serve --secret hunter2",
      },
    });

    const record = logRecords().find((line) => line.msg === "railway.settings_failed");
    expect(record).toMatchObject({
      service_id: "svc_1",
      region: "us-west2",
      replicas: 3,
      restart_policy: "ALWAYS",
      start_command_length: "serve --secret hunter2".length,
    });
    expect(rawLogLines().join("\n")).not.toContain("hunter2");
  });

  it("records the size that was refused", async () => {
    const calls: string[] = [];
    server.use(...stubs(calls, { limitsFail: true }));

    await create({ limits: { cpu: 32, memory: 64 } });

    expect(
      logRecords().find((line) => line.msg === "railway.limits_failed"),
    ).toMatchObject({ service_id: "svc_1", vcpus: 32, memory_gb: 64 });
  });
});

describe("createContainer, minting a public domain", () => {
  /** Railway answering `serviceDomainCreate`, with the input handed to the caller. */
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

  /** The two stubs every case here needs before the domain is even reached. */
  const createdAndDeployed = () => [
    api.mutation("ServiceCreate", () =>
      HttpResponse.json({ data: { serviceCreate: { id: "svc_1", name: "spun-web" } } }),
    ),
    api.mutation("ServiceInstanceDeployV2", () =>
      HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_1" } }),
    ),
  ];

  it("returns the url, with the scheme Railway serves it on", async () => {
    server.use(...createdAndDeployed(), domainOk());

    const result = await createContainer(TOKEN, {
      projectId: "p1",
      environmentId: "e1",
      name: "spun-web",
      image: "nginx:alpine",
      targetPort: 80,
    });

    expect(result).toEqual({
      serviceId: "svc_1",
      deploymentId: "dep_1",
      url: "https://spun-web-production.up.railway.app",
      outcome: "deployed",
    });
  });

  it("sends the environment, the service and the port it was given", async () => {
    let input: Record<string, unknown> | undefined;
    server.use(
      ...createdAndDeployed(),
      domainOk((i) => (input = i)),
    );

    await createContainer(TOKEN, {
      projectId: "p1",
      environmentId: "e1",
      name: "spun-web",
      image: "ghcr.io/owner/api:1",
      targetPort: 8080,
    });

    expect(input).toEqual({
      environmentId: "e1",
      serviceId: "svc_1",
      targetPort: 8080,
    });
  });

  /*
   * The order is the argument in createContainer's docblock: a domain routes to a container
   * that is already coming up, so putting it before the deploy would only create a way for a
   * refused hostname to cost someone a running container.
   */
  it("mints the domain after the deploy, never before", async () => {
    const calls: string[] = [];
    server.use(
      api.mutation("ServiceCreate", () => {
        calls.push("create");
        return HttpResponse.json({
          data: { serviceCreate: { id: "svc_1", name: "spun-web" } },
        });
      }),
      api.mutation("ServiceInstanceDeployV2", () => {
        calls.push("deploy");
        return HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_1" } });
      }),
      domainOk(() => calls.push("domain")),
    );

    await createContainer(TOKEN, {
      projectId: "p1",
      environmentId: "e1",
      name: "spun-web",
      image: "nginx:alpine",
      targetPort: 80,
    });

    expect(calls).toEqual(["create", "deploy", "domain"]);
  });

  it("mints nothing when no port was asked for", async () => {
    server.use(
      ...createdAndDeployed(),
      volumeOk(),
      api.mutation("ServiceDomainCreate", () => {
        throw new Error("must not expose a container nobody asked to expose");
      }),
    );

    const result = await createContainer(TOKEN, {
      projectId: "p1",
      environmentId: "e1",
      name: "spun-cache",
      image: "redis:7-alpine",
    });

    expect(result.url).toBeNull();
    expect(result.outcome).toBe("deployed");
  });

  /*
   * The one Railway refusal in this whole function that does NOT change the outcome. Every
   * other branch leaves an un-deployed service the user has to clean up; this leaves the
   * container they asked for, running, missing one convenience — and the row's own control
   * is the retry.
   */
  it("still reports a deployed container when Railway refuses the domain", async () => {
    server.use(
      ...createdAndDeployed(),
      api.mutation("ServiceDomainCreate", () =>
        HttpResponse.json({ errors: [{ message: "Not Authorized" }] }),
      ),
    );

    const result = await createContainer(TOKEN, {
      projectId: "p1",
      environmentId: "e1",
      name: "spun-web",
      image: "nginx:alpine",
      targetPort: 80,
    });

    expect(result).toEqual({
      serviceId: "svc_1",
      deploymentId: "dep_1",
      url: null,
      outcome: "deployed",
    });

    // The port is in the record because it is the likeliest cause: an image serving nothing
    // on the port the catalog claims, or a number someone typed for a custom image.
    expect(logRecords().find((r) => r.msg === "railway.domain_failed")).toMatchObject({
      service_id: "svc_1",
      target_port: 80,
    });
  });
});

describe("createServiceDomain", () => {
  it("omits targetPort entirely when the caller has none", async () => {
    /*
     * Omitted rather than sent as null. Both mean "infer from the deployment" to Railway,
     * but an explicit null reads as a decision — and the row control reaching this branch
     * has no port to decide with, because the catalog does not know the image.
     */
    let input: Record<string, unknown> | undefined;
    server.use(
      api.mutation("ServiceDomainCreate", ({ variables }) => {
        input = variables.input as Record<string, unknown>;
        return HttpResponse.json({
          data: {
            serviceDomainCreate: {
              id: "dom_1",
              domain: "spun-x-production.up.railway.app",
              targetPort: null,
            },
          },
        });
      }),
    );

    const url = await createServiceDomain(TOKEN, {
      environmentId: "e1",
      serviceId: "svc_1",
    });

    expect(input).toEqual({ environmentId: "e1", serviceId: "svc_1" });
    expect("targetPort" in (input ?? {})).toBe(false);
    expect(url).toBe("https://spun-x-production.up.railway.app");
  });

  it("throws on a refusal, because the whole of its action is this call", async () => {
    server.use(
      api.mutation("ServiceDomainCreate", () =>
        HttpResponse.json({ errors: [{ message: "Not Authorized" }] }),
      ),
    );

    await expect(
      createServiceDomain(TOKEN, { environmentId: "e1", serviceId: "svc_1" }),
    ).rejects.toThrow();
  });
});

describe("getEnvironmentVolumes", () => {
  /* A body rather than a response, so each resolver keeps MSW's contextual typing — the
     same reason `notAuthorized` at the top of this file is written that way. */
  const instances = (nodes: Array<Record<string, unknown>>) => ({
    data: {
      environment: {
        id: "e1",
        volumeInstances: { edges: nodes.map((node) => ({ node })) },
      },
    },
  });

  it("keys the volumes by the service each is mounted on", async () => {
    server.use(
      api.query("EnvironmentVolumes", () =>
        HttpResponse.json(
          instances([
            {
              id: "volinst_1",
              volumeId: "vol_1",
              serviceId: "svc_1",
              mountPath: "/data",
              sizeMB: 500,
              currentSizeMB: 3,
            },
          ]),
        ),
      ),
    );

    await expect(getEnvironmentVolumes(TOKEN, "e1")).resolves.toEqual({
      svc_1: {
        serviceId: "svc_1",
        volumeId: "vol_1",
        mountPath: "/data",
        sizeMB: 500,
        currentSizeMB: 3,
      },
    });
  });

  it("degrades to nothing when Railway refuses it, rather than throwing", async () => {
    /*
     * `EnvironmentVolumes` is in DEGRADING_OPERATIONS, and this is what makes that safe:
     * every consequence of the empty answer is the conservative one. The row shows no
     * volume, the destroy dialog offers no choice, and the data is kept — and the toast
     * says it was kept, so the outcome is visible rather than silent.
     */
    server.use(
      api.query("EnvironmentVolumes", () =>
        // `errors` alone, with no `data` member: that is the body Railway sends, and it is
        // also the only shape MSW's GraphQL resolver types accept.
        HttpResponse.json({
          errors: [{ message: "Not Authorized", path: ["environment"] }],
        }),
      ),
    );

    await expect(getEnvironmentVolumes(TOKEN, "e1")).resolves.toEqual({});

    // Debug rather than warn: this read runs on every dashboard render, and a token that
    // will never hold the scope would otherwise write a warn per render, forever.
    expect(logRecords().find((r) => r.msg === "railway.volumes.refused")).toMatchObject(
      {
        environment_id: "e1",
        level: "debug",
      },
    );
  });
});

describe("deleteVolume", () => {
  it("sends the volume id, not the instance id", async () => {
    // `volumeDelete` takes the Volume's id; `VolumeInstance.id` is a different value on the
    // same response, and sending it is a 'not found' that reads like a missing volume.
    let seen: string | undefined;
    server.use(
      api.mutation("VolumeDelete", ({ variables }) => {
        seen = variables.volumeId as string;
        return HttpResponse.json({ data: { volumeDelete: true } });
      }),
    );

    await deleteVolume(TOKEN, "vol_1");
    expect(seen).toBe("vol_1");
  });
});

describe("readServiceVariableNames", () => {
  /** The two aliased reads the document performs, in one handler. */
  const variables = (
    service: Record<string, string>,
    shared: Record<string, string> = {},
  ) =>
    api.query("ServiceVariables", () =>
      HttpResponse.json({ data: { service, shared } }),
    );

  const read = () =>
    readServiceVariableNames(TOKEN, {
      projectId: "p1",
      environmentId: "e1",
      serviceId: "svc_1",
    });

  it("returns names and never values", async () => {
    /*
     * The security property of this function, asserted rather than assumed. The return type
     * says `string[]`, but a mapper that returned entries would also compile — so the test
     * is over the *values*, which is what must never reach a caller and therefore a browser.
     */
    server.use(variables({ POSTGRES_PASSWORD: "hunter2", PORT: "5432" }));

    const names = await read();

    expect(names).toEqual(["PORT", "POSTGRES_PASSWORD"]);
    expect(JSON.stringify(names)).not.toContain("hunter2");
  });

  it("drops variables the environment shares with every service", async () => {
    // Not this service's to edit, and not something variableDelete could remove for it.
    server.use(variables({ OWN: "a", SHARED_TOKEN: "s" }, { SHARED_TOKEN: "s" }));

    expect(await read()).toEqual(["OWN"]);
  });

  it("keeps a shared name the service overrides with its own value", async () => {
    /*
     * The reason the subtraction is by name *and* value. A service is allowed to override a
     * shared name, and that override is genuinely the service's — dropping it by name would
     * hide a variable from its own editor, and the next save would then delete it.
     */
    server.use(variables({ SHARED_TOKEN: "mine" }, { SHARED_TOKEN: "theirs" }));

    expect(await read()).toEqual(["SHARED_TOKEN"]);
  });

  it("drops the namespace Railway sets itself", async () => {
    // validation.ts refuses these on the way in, so a row for one could never be submitted.
    server.use(variables({ RAILWAY_PRIVATE_DOMAIN: "x", KEEP: "y" }));

    expect(await read()).toEqual(["KEEP"]);
  });
});

describe("updateContainer", () => {
  const target = {
    projectId: "p1",
    environmentId: "e1",
    serviceId: "svc_1",
  };

  it("sends nothing at all when nothing changed", async () => {
    /*
     * No handlers registered, and `onUnhandledRequest: "error"` is what makes that an
     * assertion: any request here fails the test. A form submitted untouched is something
     * people do, and it must not cost a redeploy.
     */
    const result = await updateContainer(TOKEN, target);

    expect(result).toEqual({ deploymentId: null, outcome: "unchanged" });
  });

  it("renames through serviceUpdate, which is not the instance mutation", async () => {
    /*
     * The correction this ticket turned on. `ServiceInstanceUpdateInput` has no `name`
     * member and never had one — the name lives on `Service` — so a rename that went through
     * serviceInstanceUpdate would be a document that does not validate, and one that sent
     * `name` inside `source` would be silently ignored by Railway.
     */
    let sent: Record<string, unknown> | undefined;
    server.use(
      api.mutation("ServiceUpdate", ({ variables }) => {
        sent = variables;
        return HttpResponse.json({
          data: { serviceUpdate: { id: "svc_1", name: "spun-renamed" } },
        });
      }),
    );

    const result = await updateContainer(TOKEN, { ...target, name: "spun-renamed" });

    expect(sent).toEqual({ id: "svc_1", input: { name: "spun-renamed" } });
    // A rename changes nothing about the running container, so nothing is redeployed.
    expect(result).toEqual({ deploymentId: null, outcome: "updated" });
  });

  it("changes the image and redeploys, returning the new deployment to stream", async () => {
    const calls: string[] = [];
    let sent: Record<string, unknown> | undefined;
    server.use(
      api.mutation("ServiceInstanceUpdate", ({ variables }) => {
        calls.push("image");
        sent = variables;
        return HttpResponse.json({ data: { serviceInstanceUpdate: true } });
      }),
      api.mutation("ServiceInstanceDeployV2", () => {
        calls.push("deploy");
        return HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_2" } });
      }),
    );

    const result = await updateContainer(TOKEN, { ...target, image: "postgres:17" });

    expect(calls).toEqual(["image", "deploy"]);
    expect(sent).toEqual({
      serviceId: "svc_1",
      environmentId: "e1",
      // `source` alone. Every other member of the input is a feature with its own ticket,
      // and sending one would overwrite a setting nobody asked this form about.
      input: { source: { image: "postgres:17" } },
    });
    expect(result).toEqual({ deploymentId: "dep_2", outcome: "deployed" });
  });

  it("deletes removed variables before writing the rest, then deploys", async () => {
    /*
     * Order twice over. Deletes precede the upsert so a row renamed in the editor cannot
     * have its delete land after its write; the whole variable block precedes the deploy for
     * the reason createContainer gives — a container that boots without the variable it
     * needs crash-loops in front of the user.
     */
    const calls: string[] = [];
    const deleted: string[] = [];
    let upserted: Record<string, unknown> | undefined;
    server.use(
      api.mutation("VariableDelete", ({ variables }) => {
        calls.push("delete");
        deleted.push((variables.input as { name: string }).name);
        return HttpResponse.json({ data: { variableDelete: true } });
      }),
      api.mutation("VariableCollectionUpsert", ({ variables }) => {
        calls.push("upsert");
        upserted = variables.input as Record<string, unknown>;
        return HttpResponse.json({ data: { variableCollectionUpsert: 1 } });
      }),
      api.mutation("ServiceInstanceDeployV2", () => {
        calls.push("deploy");
        return HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_3" } });
      }),
    );

    const result = await updateContainer(TOKEN, {
      ...target,
      variables: { KEPT: "new" },
      removeVariables: ["GONE", "ALSO_GONE"],
    });

    expect(calls).toEqual(["delete", "delete", "upsert", "deploy"]);
    expect(deleted).toEqual(["GONE", "ALSO_GONE"]);
    /*
     * `replace: false` even on an edit, where the service does have variables to replace.
     * Removal is per-key above, so `replace: true` would add only the power to delete
     * something the read failed to report — the one failure with no way back.
     */
    expect(upserted).toMatchObject({ replace: false, skipDeploys: true });
    expect(result).toEqual({ deploymentId: "dep_3", outcome: "deployed" });
  });

  it("reports a refused variable change without deploying, and logs no value", async () => {
    server.use(
      api.mutation("VariableCollectionUpsert", () =>
        HttpResponse.json({ errors: [{ message: "Not Authorized" }] }),
      ),
    );

    const result = await updateContainer(TOKEN, {
      ...target,
      variables: { SECRET: "hunter2" },
    });

    expect(result).toEqual({ deploymentId: null, outcome: "variables_failed" });

    const record = logRecords().find((r) => r.msg === "railway.variables_failed");
    expect(record).toMatchObject({ service_id: "svc_1", variable_count: 1 });
    // The count carries the diagnostic content; the names and values carry none of it.
    expect(rawLogLines().join("\n")).not.toContain("hunter2");
    expect(rawLogLines().join("\n")).not.toContain("SECRET");
  });

  it("reports a refused deploy after the change has already landed", async () => {
    /*
     * Caught rather than thrown, exactly as in createContainer: the image has changed by
     * this point, so a throw would lose which half succeeded and the user would be told
     * nothing happened when something did.
     */
    server.use(
      api.mutation("ServiceInstanceUpdate", () =>
        HttpResponse.json({ data: { serviceInstanceUpdate: true } }),
      ),
      api.mutation("ServiceInstanceDeployV2", () =>
        HttpResponse.json({ errors: [{ message: "Nope" }] }),
      ),
    );

    const result = await updateContainer(TOKEN, { ...target, image: "postgres:17" });

    expect(result).toEqual({ deploymentId: null, outcome: "deploy_failed" });
  });

  it("throws when the rename is refused, because nothing has changed yet", async () => {
    // The other half of that split. No mutation has landed, so the honest answer is the
    // error and a form the user can resubmit.
    server.use(
      api.mutation("ServiceUpdate", () =>
        HttpResponse.json({ errors: [{ message: "Nope" }] }),
      ),
    );

    await expect(
      updateContainer(TOKEN, { ...target, name: "spun-taken" }),
    ).rejects.toThrow();
  });
});

describe("destroyContainer", () => {
  it("sends the service id", async () => {
    let seen: string | undefined;
    server.use(
      api.mutation("ServiceDelete", ({ variables }) => {
        seen = variables.id as string;
        return HttpResponse.json({ data: { serviceDelete: true } });
      }),
    );

    await destroyContainer(TOKEN, "svc_1");
    expect(seen).toBe("svc_1");
  });
});

describe("listServiceDeployments", () => {
  /** One node of the connection, with only the members the document selects. */
  const dep = (
    id: string,
    createdAt: string,
    { status = "SUCCESS", canRollback = true } = {},
  ) => ({ node: { id, status, createdAt, canRollback } });

  const params = { projectId: "p1", environmentId: "e1", serviceId: "svc_1" };

  it("scopes the read to one service and asks for the newest entries", async () => {
    let variables: Record<string, unknown> = {};
    server.use(
      api.query("Deployments", (req) => {
        variables = req.variables;
        return HttpResponse.json({ data: { deployments: { edges: [] } } });
      }),
    );

    await listServiceDeployments(TOKEN, params);

    /*
     * All three ids, not just the service. `DeploymentListInput` accepts each of them and
     * Railway's own deprecation notice on `service.deployments` is about scoped access
     * control — sending the narrowest input the field offers is what that notice asks for.
     */
    expect(variables.input).toEqual({
      projectId: "p1",
      environmentId: "e1",
      serviceId: "svc_1",
    });
    expect(variables.last).toBe(LIST.DEPLOYMENT_HISTORY);
  });

  it("reports an empty history as answered, not refused", async () => {
    // The distinction the caller renders two different sentences from: a service that has
    // never deployed is not a service whose deployments could not be read.
    server.use(
      api.query("Deployments", () =>
        HttpResponse.json({ data: { deployments: { edges: [] } } }),
      ),
    );

    await expect(listServiceDeployments(TOKEN, params)).resolves.toEqual({
      entries: [],
      refused: false,
    });
  });

  it("returns the newest deployment first, whatever order Railway sent", async () => {
    server.use(
      api.query("Deployments", () =>
        HttpResponse.json({
          data: {
            deployments: {
              edges: [
                dep("dep_old", "2026-08-15T09:00:00.000Z"),
                dep("dep_new", "2026-08-15T11:00:00.000Z"),
                dep("dep_mid", "2026-08-15T10:00:00.000Z"),
              ],
            },
          },
        }),
      ),
    );

    /*
     * The document asks for `last`, on the strength of the one observation this app has of
     * Railway's Relay ordering — and sorts anyway. An upstream ordering that changed would
     * otherwise silently offer the wrong entries with nothing failing.
     */
    const { entries } = await listServiceDeployments(TOKEN, params);
    expect(entries.map((d) => d.id)).toEqual(["dep_new", "dep_mid", "dep_old"]);
  });

  it("maps the status to a container state and keeps Railway's own enum member", async () => {
    server.use(
      api.query("Deployments", () =>
        HttpResponse.json({
          data: {
            deployments: {
              edges: [
                dep("dep_1", "2026-08-15T09:00:00.000Z", {
                  status: "CRASHED",
                  canRollback: false,
                }),
              ],
            },
          },
        }),
      ),
    );

    expect(await listServiceDeployments(TOKEN, params)).toEqual({
      entries: [
        {
          id: "dep_1",
          state: "failed",
          rawStatus: "CRASHED",
          createdAt: "2026-08-15T09:00:00.000Z",
          canRollback: false,
        },
      ],
      refused: false,
    });
  });

  it("degrades to an empty list, and says the refusal is why", async () => {
    server.use(
      api.query("Deployments", () =>
        HttpResponse.json({
          data: null,
          errors: [{ message: "Not Authorized", path: ["deployments"] }],
        }),
      ),
    );

    /*
     * Does not throw, which is the whole reason this read is `gqlPartial` and has a
     * DEGRADING_OPERATIONS entry. It is also what makes `rollback` fail closed: no entries
     * means the posted deployment id matches nothing, so the mutation is never sent.
     */
    await expect(listServiceDeployments(TOKEN, params)).resolves.toEqual({
      entries: [],
      refused: true,
    });

    const refused = logRecords().filter(
      (record) => record.msg === "railway.deployments.refused",
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ service_id: "svc_1" });
  });
});

describe("rollbackDeployment", () => {
  it("sends the deployment id", async () => {
    let seen: string | undefined;
    server.use(
      api.mutation("DeploymentRollback", ({ variables }) => {
        seen = variables.id as string;
        return HttpResponse.json({ data: { deploymentRollback: true } });
      }),
    );

    await rollbackDeployment(TOKEN, "dep_old");
    expect(seen).toBe("dep_old");
  });
});

describe("getDeployment", () => {
  it("returns the deployment", async () => {
    server.use(
      api.query("Deployment", () =>
        HttpResponse.json({
          data: { deployment: { id: "dep_1", status: "BUILDING", updatedAt: null } },
        }),
      ),
    );

    expect(await getDeployment(TOKEN, "dep_1")).toMatchObject({ status: "BUILDING" });
  });

  it("returns null for a deployment that no longer exists", async () => {
    server.use(
      api.query("Deployment", () => HttpResponse.json({ data: { deployment: null } })),
    );
    expect(await getDeployment(TOKEN, "gone")).toBeNull();
  });
});

describe("getDeploymentFailure", () => {
  /** One node of the event feed, with only the members the picker reads. */
  const evt = (step: string, payload: Record<string, unknown> | null = null) => ({
    node: { step, payload },
  });

  it("reads the tail of the feed and reports the newest reason", async () => {
    let variables: Record<string, unknown> = {};
    server.use(
      api.query("DeploymentEvents", (req) => {
        variables = req.variables;
        return HttpResponse.json({
          data: {
            deploymentEvents: {
              edges: [
                evt("SNAPSHOT_CODE", { error: null }),
                evt("BUILD_IMAGE", { error: "manifest for redis:nope not found" }),
              ],
            },
          },
        });
      }),
    );

    expect(await getDeploymentFailure(TOKEN, "dep_1")).toEqual({
      step: "BUILD_IMAGE",
      reason: "manifest for redis:nope not found",
    });
    expect(variables).toEqual({ id: "dep_1", last: STREAM.FAILURE_EVENTS });
  });

  it("returns null for a feed with nothing in it", async () => {
    server.use(
      api.query("DeploymentEvents", () =>
        HttpResponse.json({ data: { deploymentEvents: { edges: [] } } }),
      ),
    );

    expect(await getDeploymentFailure(TOKEN, "dep_1")).toBeNull();
  });

  it("keeps the step Railway did answer when it refuses the payload", async () => {
    /*
     * The reason this uses gqlPartial. Railway refuses a field it does not permit with
     * HTTP 200, an errors[] entry and the field nulled — `gql` throws on that and would
     * discard the step that arrived intact beside it.
     */
    server.use(
      api.query("DeploymentEvents", () =>
        HttpResponse.json({
          data: { deploymentEvents: { edges: [evt("HEALTHCHECK", null)] } },
          errors: [
            {
              message: "Not Authorized",
              path: ["deploymentEvents", "edges", "0", "node", "payload"],
              extensions: { code: "INTERNAL_SERVER_ERROR" },
            },
          ],
        }),
      ),
    );

    expect(await getDeploymentFailure(TOKEN, "dep_1")).toEqual({
      step: "HEALTHCHECK",
      reason: null,
    });
    expect(logRecords().map((r) => r.msg)).toContain(
      "railway.deployment.failure_reason_refused",
    );
  });

  it("bounds an unbounded reason before it can leave the server", async () => {
    server.use(
      api.query("DeploymentEvents", () =>
        HttpResponse.json({
          data: {
            deploymentEvents: {
              edges: [evt("BUILD_IMAGE", { error: "overflow ".repeat(2000) })],
            },
          },
        }),
      ),
    );

    const failure = await getDeploymentFailure(TOKEN, "dep_1");

    expect(failure?.reason?.length).toBeLessThanOrEqual(STREAM.FAILURE_REASON_MAX + 1);
  });

  it("never writes the reason text to the log, only its length", async () => {
    // Unbounded and partly container-authored, so it is the label the logging rules keep
    // out of a log store. The user reads it on their own screen instead.
    const secretish = "postgres://someone:hunter2@db.internal:5432";
    server.use(
      api.query("DeploymentEvents", () =>
        HttpResponse.json({
          data: {
            deploymentEvents: {
              edges: [evt("PRE_DEPLOY_COMMAND", { error: secretish })],
            },
          },
        }),
      ),
    );

    await getDeploymentFailure(TOKEN, "dep_1");

    expect(rawLogLines().join("\n")).not.toContain("hunter2");
    const record = logRecords().find(
      (r) => r.msg === "railway.deployment.failure_reason",
    );
    expect(record).toMatchObject({
      step: "PRE_DEPLOY_COMMAND",
      reason_length: secretish.length,
    });
  });

  it("throws a transport failure rather than swallowing it here", async () => {
    /*
     * Deliberate: every other read in this file throws, and the monitor's catch is the one
     * place "best effort" is spelled out. A second swallow here would mean two.
     */
    server.use(
      api.query("DeploymentEvents", () => HttpResponse.json({}, { status: 500 })),
    );

    await expect(getDeploymentFailure(TOKEN, "dep_1")).rejects.toThrow();
  });
});

describe("getLogs", () => {
  it("reads deploy logs by default and applies the backfill limit", async () => {
    let variables: Record<string, unknown> = {};
    server.use(
      api.query("DeploymentLogs", (req) => {
        variables = req.variables;
        return HttpResponse.json({
          data: { deploymentLogs: [{ timestamp: "t", message: "hello" }] },
        });
      }),
    );

    const lines = await getLogs(TOKEN, "dep_1", "deploy");

    expect(lines).toEqual([{ timestamp: "t", message: "hello" }]);
    expect(variables.limit).toBe(STREAM.BACKFILL_LINES);
  });

  it("reads build logs from the other field", async () => {
    server.use(
      api.query("BuildLogs", () =>
        HttpResponse.json({
          data: { buildLogs: [{ timestamp: "t", message: "step 1" }] },
        }),
      ),
    );

    expect(await getLogs(TOKEN, "dep_1", "build")).toHaveLength(1);
  });

  it("treats a null log field as empty", async () => {
    server.use(
      api.query("DeploymentLogs", () =>
        HttpResponse.json({ data: { deploymentLogs: null } }),
      ),
    );

    expect(await getLogs(TOKEN, "dep_1", "deploy")).toEqual([]);
  });
});

describe("getProjectMetrics", () => {
  /** Railway's real refusal shape, restated here so this block stands alone. */
  const notAuthorized = (path: string[]) => ({
    message: "Not Authorized",
    path,
    extensions: { code: "INTERNAL_SERVER_ERROR" },
  });

  /*
   * The shape a live probe returned: usage and ceilings for each service, plus the one
   * aggregate row Railway adds per measurement with no `serviceId` on it.
   */
  const metricsData = [
    {
      measurement: "CPU_USAGE",
      tags: { serviceId: "svc_1" },
      values: [{ ts: 1_760_000_000, value: 0.25 }],
    },
    {
      measurement: "MEMORY_USAGE_GB",
      tags: { serviceId: "svc_1" },
      values: [{ ts: 1_760_000_000, value: 0.5 }],
    },
    {
      measurement: "CPU_LIMIT",
      tags: { serviceId: "svc_1" },
      values: [{ ts: 1_760_000_000, value: 2 }],
    },
    {
      measurement: "MEMORY_LIMIT_GB",
      tags: { serviceId: "svc_1" },
      values: [{ ts: 1_760_000_000, value: 0.99999744 }],
    },
    {
      measurement: "CPU_USAGE",
      tags: { serviceId: "svc_2" },
      values: [{ ts: 1_760_000_000, value: 1.25 }],
    },
    {
      measurement: "CPU_USAGE",
      tags: { serviceId: null },
      values: [{ ts: 1_760_000_000, value: 0 }],
    },
  ];

  const projectData = {
    id: "p1",
    workspace: {
      id: "ws_1",
      name: "Acme",
      customer: {
        currentUsage: 18.4,
        billingPeriod: { start: "2026-08-01T00:00:00Z", end: "2026-08-31T00:00:00Z" },
      },
    },
  };

  it("reads usage per service and the workspace's spend in one request", async () => {
    server.use(
      api.query("ProjectMetrics", () =>
        HttpResponse.json({ data: { metrics: metricsData, project: projectData } }),
      ),
    );

    const { metrics, spend } = await getProjectMetrics(TOKEN, "p1", "e1");

    expect(metrics.svc_1).toEqual({
      serviceId: "svc_1",
      cpuCores: 0.25,
      memoryGb: 0.5,
      cpuLimitCores: 2,
      memoryLimitGb: 0.99999744,
      sampledAt: 1_760_000_000,
    });
    expect(metrics.svc_2?.cpuCores).toBe(1.25);
    // The aggregate row Railway sends with no serviceId does not become a service.
    expect(Object.keys(metrics)).toEqual(["svc_1", "svc_2"]);
    expect(spend).toEqual({
      currentUsage: 18.4,
      periodStart: "2026-08-01T00:00:00Z",
      periodEnd: "2026-08-31T00:00:00Z",
      workspaceName: "Acme",
    });
  });

  it("asks for the two usage measurements and the two ceilings, in one request", async () => {
    /*
     * `measurements` is a query variable, so the ceilings each row now shows cost no second
     * round trip — which is the only reason they fit inside ADR-10's request budget. The
     * assertion is on the variable rather than on the response, because that budget is about
     * what leaves this process.
     *
     * CPU_USAGE, never CPU_USAGE_2. The higher-numbered member exists on the schema and reads
     * like the newer of the two; a live probe showed it returning an empty array, so an
     * "upgrade" to it would silently blank the CPU column. This is where that is pinned.
     */
    let sent: Record<string, unknown> | undefined;
    server.use(
      api.query("ProjectMetrics", ({ variables }) => {
        sent = variables;
        return HttpResponse.json({
          data: { metrics: metricsData, project: projectData },
        });
      }),
    );

    await getProjectMetrics(TOKEN, "p1", "e1");

    expect(sent?.measurements).toEqual([
      "CPU_USAGE",
      "MEMORY_USAGE_GB",
      "CPU_LIMIT",
      "MEMORY_LIMIT_GB",
    ]);
    expect(sent?.measurements).not.toContain("CPU_USAGE_2");
  });

  it("keeps the usage when the workspace half is refused", async () => {
    /*
     * The case gqlPartial exists for, and the one a token without workspace:viewer hits on
     * every single render. `gql` would throw here and discard readings that arrived intact.
     */
    server.use(
      api.query("ProjectMetrics", () =>
        HttpResponse.json({
          data: { metrics: metricsData, project: { id: "p1", workspace: null } },
          errors: [notAuthorized(["project", "workspace"])],
        }),
      ),
    );

    const { metrics, spend } = await getProjectMetrics(TOKEN, "p1", "e1");

    expect(Object.keys(metrics)).toEqual(["svc_1", "svc_2"]);
    expect(spend).toBeNull();

    const record = logRecords().find((r) => r.msg === "railway.metrics.refused");
    expect(record).toBeDefined();
    // Debug, never warn: this fires on every render for a token that will never hold the
    // scope, and a warn per render is how a log store teaches people to ignore warns.
    expect(record?.level).toBe("debug");
    expect(
      logRecords().filter((r) => r.level === "warn" || r.level === "error"),
    ).toEqual([]);
  });

  it("keeps the spend when the metrics half is refused", async () => {
    // The mirror. Losing the readout must not lose the one real cost figure on the page.
    server.use(
      api.query("ProjectMetrics", () =>
        HttpResponse.json({
          data: { metrics: null, project: projectData },
          errors: [notAuthorized(["metrics"])],
        }),
      ),
    );

    const { metrics, spend } = await getProjectMetrics(TOKEN, "p1", "e1");

    expect(metrics).toEqual({});
    expect(spend?.currentUsage).toBe(18.4);
  });

  it("returns empty rather than throwing when both halves are refused", async () => {
    /*
     * The whole argument for Query.metrics being an OPTIONAL_FIELDS entry: a refusal
     * degrades the row, it does not blank the dashboard. A throw here would take the
     * container list down with it.
     */
    server.use(
      api.query("ProjectMetrics", () =>
        HttpResponse.json({
          data: { metrics: null, project: null },
          errors: [notAuthorized(["metrics"]), notAuthorized(["project"])],
        }),
      ),
    );

    await expect(getProjectMetrics(TOKEN, "p1", "e1")).resolves.toEqual({
      metrics: {},
      spend: null,
    });
  });

  it("still throws on a rate limit, because that is not a refusal", async () => {
    // The transport contract is unchanged. A 429 is the server saying "later", not "no",
    // and swallowing it would hide the one failure the retry logic is built around.
    server.use(
      api.query("ProjectMetrics", () =>
        HttpResponse.json({}, { status: 429, headers: { "retry-after": "0" } }),
      ),
    );

    await expect(getProjectMetrics(TOKEN, "p1", "e1")).rejects.toThrow();
  });
});
