import { HttpResponse, graphql } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { STREAM } from "@/lib/constants";
import { logRecords, rawLogLines } from "@/test/log-capture";
import {
  createContainer,
  destroyContainer,
  getDeployment,
  getDeploymentFailure,
  getLogs,
  getProjectContainers,
  getProjectMetrics,
  listProjects,
} from "./api";
import { railwayApiUrl } from "./client";

const api = graphql.link(railwayApiUrl());
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const TOKEN = "token";

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

    expect(calls).toEqual(["create", "variables", "deploy"]);
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

  it("issues no variables call for an image that boots bare", async () => {
    server.use(
      api.mutation("ServiceCreate", () =>
        HttpResponse.json({ data: { serviceCreate: { id: "svc_1", name: "spun-x" } } }),
      ),
      api.mutation("VariableCollectionUpsert", () => {
        throw new Error("no variables should be sent");
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
        image: "redis:7-alpine",
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
      outcome: "deployed",
    });
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
      measurement: "CPU_USAGE",
      tags: { serviceId: "svc_2" },
      values: [{ ts: 1_760_000_000, value: 1.25 }],
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
      sampledAt: 1_760_000_000,
    });
    expect(metrics.svc_2?.cpuCores).toBe(1.25);
    expect(spend).toEqual({
      currentUsage: 18.4,
      periodStart: "2026-08-01T00:00:00Z",
      periodEnd: "2026-08-31T00:00:00Z",
      workspaceName: "Acme",
    });
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
