/**
 * Projects and environments, and the containers inside one of them.
 *
 * The reads a dashboard needs before it can show anything: what the signed-in user can
 * reach, and what is in the project they picked. Everything here is a read except the two
 * creates at the bottom, which make the place the other modules then act on.
 */

import "server-only";

import { log } from "@/lib/logger";
import { gql, gqlPartial } from "./client";
import { RailwayApiError } from "./errors";
import {
  ENVIRONMENT_CREATE_MUTATION,
  PROJECTS_PERSONAL_QUERY,
  PROJECTS_WORKSPACE_QUERY,
  PROJECT_CREATE_MUTATION,
  PROJECT_QUERY,
} from "./operations";
import {
  nodes,
  toContainers,
  toProject,
  toProjects,
  toWorkspaces,
  type ViewerNode,
} from "./mappers";
import type {
  Container,
  RailwayEnvironment,
  RailwayProject,
  RailwayWorkspace,
} from "./types";
import type { Refusable, TypedDocument } from "./typed-document";

export type Viewer = { id: string; name?: string; email?: string };

/** A project source that answered, or the reason it did not. */
type SourceResult = {
  /** Names the source in the log and in the partial-failure notice. */
  name: "personal" | "workspace";
  viewer: ViewerNode | null;
  error: RailwayApiError | null;
};

/**
 * Every project the signed-in user can reach, merged from each source that answered.
 *
 * Railway exposes projects in more than one place and an OAuth token's view of each is
 * not documented — a project plainly visible in Railway's own dashboard can come back
 * from either, both, or neither. They are read as independent requests so that a source
 * the token has no scope for costs only that source: a refused `workspaces` field used
 * to discard an intact personal project list along with it, which is the failure that
 * made this dashboard useless.
 *
 * Throws only when *every* source failed. A caller that gets projects back also gets
 * the failures, so it can say that part of the list is missing rather than implying the
 * list is complete.
 */
export async function listProjects(
  accessToken: string,
  signal?: AbortSignal,
): Promise<{
  viewer: Viewer;
  projects: RailwayProject[];
  /**
   * Where a new project could go, from the same read.
   *
   * Returned rather than folded into the projects, because a workspace holding no projects
   * yet is still somewhere to create one — and `toProjects` can only ever mention a
   * workspace that already had something in it.
   */
  workspaces: RailwayWorkspace[];
  failures: RailwayApiError[];
}> {
  /*
   * `toViewer` per source rather than one shared result type, because the two documents
   * select different halves of `me` and now say so: ProjectsPersonal carries `projects`,
   * ProjectsWorkspace carries `workspaces`, and neither generated type has the other's
   * field. `ViewerNode` stays the merged shape the mappers read, and each source maps into
   * it — which is where the optionality on that type comes from and is now the only place
   * it is claimed.
   */
  const read = async <TResult extends { me: unknown }>(
    name: SourceResult["name"],
    query: TypedDocument<TResult, Record<string, never>>,
    toViewer: (me: NonNullable<Refusable<TResult>["me"]>) => ViewerNode,
  ): Promise<SourceResult> => {
    try {
      const { data, errors } = await gqlPartial(query, {}, { accessToken, signal });
      // `me` itself refused means nothing usable came back, however the transport went.
      if (!data?.me) return { name, viewer: null, error: errors[0] ?? null };
      return { name, viewer: toViewer(data.me), error: errors[0] ?? null };
    } catch (error) {
      if (error instanceof RailwayApiError) return { name, viewer: null, error };
      throw error;
    }
  };

  const sources = await Promise.all([
    read("personal", PROJECTS_PERSONAL_QUERY, (me) => ({
      id: me.id,
      // Narrowed rather than spread through: `name` is nullable on the live schema, and
      // ViewerNode carries both of these as absent-or-present rather than nullable.
      ...(me.name ? { name: me.name } : {}),
      ...(me.email ? { email: me.email } : {}),
      projects: me.projects,
    })),
    read("workspace", PROJECTS_WORKSPACE_QUERY, (me) => ({
      id: me.id,
      workspaces: me.workspaces,
    })),
  ]);

  const answered = sources.filter((source) => source.viewer !== null);
  const failures = sources
    .map((source) => source.error)
    .filter((error): error is RailwayApiError => error !== null);

  /*
   * Per source, because the caller only ever surfaces `failures[0]` and never says which
   * read it came from. "The workspace source has been refused for a week and nobody
   * noticed because the personal one still answers" is exactly the shape of degradation
   * a merged list hides, and this is the only place that distinction still exists.
   */
  for (const source of sources) {
    if (!source.error) continue;
    log.warn("railway.projects.source_failed", {
      source: source.name,
      answered: source.viewer !== null,
      error: source.error,
    });
  }

  /*
   * Nothing answered at all. The first failure is thrown rather than a summary, because
   * it is the one carrying the classification and the refused path — which is what
   * turns this into "approve workspace access" instead of "something went wrong".
   */
  if (answered.length === 0) {
    throw (
      failures.find((error) => error.kind === "auth") ??
      failures[0] ??
      new RailwayApiError("Railway returned no project sources", {
        kind: "graphql",
        operation: "ProjectsPersonal",
      })
    );
  }

  /*
   * Identity comes from whichever source answered, preferring the personal one because
   * that is the document carrying `name` and `email`.
   *
   * `answered[0]` is narrowed rather than asserted. It cannot be undefined — the branch
   * above returns when the list is empty — but that was expressed only by the throw
   * four lines up, and noUncheckedIndexedAccess exists precisely so the type system
   * does not have to take that on trust. This was the one `!` in src/, doubled.
   */
  const personal = answered.find((s) => s.name === "personal")?.viewer;
  const workspace = answered.find((s) => s.name === "workspace")?.viewer;
  const identity = personal ?? workspace;
  if (!identity) {
    throw new RailwayApiError("Railway returned no viewer", {
      kind: "graphql",
      operation: "ProjectsPersonal",
    });
  }

  // De-duplication is toProjects' job, so it is fed one merged viewer rather than being
  // called per source and re-merged here.
  const merged: ViewerNode = {
    id: identity.id,
    ...(identity.name ? { name: identity.name } : {}),
    ...(identity.email ? { email: identity.email } : {}),
    projects: personal?.projects ?? null,
    workspaces: workspace?.workspaces ?? null,
  };

  return {
    viewer: { id: merged.id, name: merged.name, email: merged.email },
    projects: toProjects(merged),
    workspaces: toWorkspaces(merged),
    failures,
  };
}

/**
 * Everything the dashboard needs for one project, in a single request.
 *
 * Services created outside this app come back too, marked `managed: false`. They are
 * shown for context — an accurate picture of the environment matters — but the UI and
 * the spin-down action both refuse to destroy them.
 */
export async function getProjectContainers(
  accessToken: string,
  projectId: string,
  environmentId: string,
  signal?: AbortSignal,
): Promise<{ project: RailwayProject; containers: Container[] }> {
  const data = await gql(PROJECT_QUERY, { id: projectId }, { accessToken, signal });

  return {
    project: toProject(data.project),
    containers: toContainers(nodes(data.project.services), environmentId),
  };
}

/**
 * A new project, with whatever environment Railway created alongside it.
 *
 * Returns the mapped `RailwayProject` rather than the raw node so the caller can select it
 * immediately: the environments come back in this same response — see
 * PROJECT_CREATE_MUTATION — which is the difference between landing the user on their new
 * project and landing them on the empty state they just acted on.
 *
 * An absent `workspaceId` is a personal project, which is Railway's own rule rather than a
 * default this app applies — so the member is omitted rather than sent as null, and there
 * is no branch here for the personal case.
 *
 * Nothing here is prefixed. `MANAGED_PREFIX` gates destroy, this app offers no way to
 * delete a project, and a marker that guards nothing would only put `spun-` on a name the
 * user typed and then reads back in Railway's own dashboard.
 */
export async function createProject(
  accessToken: string,
  name: string,
  workspaceId?: string,
  signal?: AbortSignal,
): Promise<RailwayProject> {
  const data = await gql(
    PROJECT_CREATE_MUTATION,
    { input: { name, ...(workspaceId ? { workspaceId } : {}) } },
    { accessToken, signal },
  );
  return toProject(data.projectCreate);
}

/**
 * A new, empty environment in an existing project.
 *
 * Empty is the contract, not an accident of the arguments — see
 * ENVIRONMENT_CREATE_MUTATION for why nothing is seeded or deployed into it.
 */
export async function createEnvironment(
  accessToken: string,
  projectId: string,
  name: string,
  signal?: AbortSignal,
): Promise<RailwayEnvironment> {
  const data = await gql(
    ENVIRONMENT_CREATE_MUTATION,
    { input: { projectId, name, skipInitialDeploys: true } },
    { accessToken, signal },
  );
  return { id: data.environmentCreate.id, name: data.environmentCreate.name };
}
