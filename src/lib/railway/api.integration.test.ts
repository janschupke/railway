import { HttpResponse, graphql } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { STREAM } from "@/lib/constants";
import {
  createContainer,
  destroyContainer,
  getDeployment,
  getLogs,
  getProjectContainers,
  listProjects,
} from "./api";
import { railwayApiUrl } from "./client";

const api = graphql.link(railwayApiUrl());
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const TOKEN = "token";

describe("listProjects", () => {
  it("flattens the viewer and their projects out of Relay connections", async () => {
    server.use(
      api.query("Projects", () =>
        HttpResponse.json({
          data: {
            me: {
              id: "u1",
              name: "Ada",
              email: "ada@example.com",
              projects: {
                edges: [
                  {
                    node: {
                      id: "p1",
                      name: "Demo",
                      environments: {
                        edges: [{ node: { id: "e1", name: "production" } }],
                      },
                    },
                  },
                ],
              },
            },
          },
        }),
      ),
    );

    const { viewer, projects } = await listProjects(TOKEN);

    expect(viewer).toEqual({ id: "u1", name: "Ada", email: "ada@example.com" });
    expect(projects).toEqual([
      { id: "p1", name: "Demo", environments: [{ id: "e1", name: "production" }] },
    ]);
  });

  it("copes with a user who has no projects", async () => {
    server.use(
      api.query("Projects", () =>
        HttpResponse.json({ data: { me: { id: "u1", projects: { edges: [] } } } }),
      ),
    );

    expect((await listProjects(TOKEN)).projects).toEqual([]);
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

    expect(result).toEqual({ serviceId: "svc_1", deploymentId: "dep_1" });
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

    expect(result).toEqual({ serviceId: "svc_1", deploymentId: null });
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
