/**
 * Reading what a token can reach: the merged project list, and one project's containers.
 */

import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { TOKEN, projectNode, railwayApi, setupRailwayServer } from "@/test/railway-msw";
import { getProjectContainers, listProjects } from "./projects";
import { railwayApiUrl } from "./client";

const api = railwayApi(railwayApiUrl());
const server = setupRailwayServer();

describe("listProjects", () => {
  /** The two documents the project list is assembled from, with usable defaults. */
  const sources = ({
    viewer = { id: "u1", name: "Ada", email: "ada@example.com" },
    personal = [] as ReturnType<typeof projectNode>[],
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
    server.use(...sources({ personal: [projectNode("p1", "Demo")] }));

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
        workspaces: [
          { id: "ws1", name: "Acme", projects: [projectNode("p1", "Demo")] },
        ],
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
          { id: "ws1", name: "Acme", projects: [projectNode("p1", "Demo")] },
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
      ...sources({ personal: [projectNode("p1", "Demo")] }).slice(0, 1),
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
        personal: [projectNode("p1", "Demo")],
        workspaces: [
          {
            id: "ws1",
            name: "Acme",
            projects: [projectNode("p1", "Demo"), projectNode("p2", "Other")],
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
      ...sources({ personal: [projectNode("p1", "Demo")] }).slice(0, 1),
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
    server.use(...sources({ personal: [projectNode("p1", "Demo")] }));

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
        workspaces: [{ id: "w1", name: "Acme", projects: [projectNode("p2", "Team")] }],
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
