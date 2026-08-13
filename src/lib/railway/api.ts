import "server-only";

import { STREAM } from "@/lib/constants";
import { log } from "@/lib/logger";
import { gql, gqlPartial } from "./client";
import { RailwayApiError } from "./errors";
import {
  BUILD_LOGS_QUERY,
  DEPLOYMENT_LOGS_QUERY,
  DEPLOYMENT_QUERY,
  PROJECTS_PERSONAL_QUERY,
  PROJECTS_WORKSPACE_QUERY,
  PROJECT_QUERY,
  SERVICE_CREATE_MUTATION,
  SERVICE_DELETE_MUTATION,
  SERVICE_DEPLOY_MUTATION,
  VARIABLE_COLLECTION_UPSERT_MUTATION,
} from "./operations";
import {
  nodes,
  toContainers,
  toProject,
  toProjects,
  type Edges,
  type ProjectNode,
  type ServiceNode,
  type ViewerNode,
} from "./mappers";
import type { Container, LogLine, RailwayProject } from "./types";

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
  failures: RailwayApiError[];
}> {
  const read = async (
    name: SourceResult["name"],
    query: string,
    operationName: string,
  ): Promise<SourceResult> => {
    try {
      const { data, errors } = await gqlPartial<{ me: ViewerNode }>(
        query,
        {},
        { accessToken, operationName, signal },
      );
      // `me` itself refused means nothing usable came back, however the transport went.
      if (!data?.me) return { name, viewer: null, error: errors[0] ?? null };
      return { name, viewer: data.me, error: errors[0] ?? null };
    } catch (error) {
      if (error instanceof RailwayApiError) return { name, viewer: null, error };
      throw error;
    }
  };

  const sources = await Promise.all([
    read("personal", PROJECTS_PERSONAL_QUERY, "ProjectsPersonal"),
    read("workspace", PROJECTS_WORKSPACE_QUERY, "ProjectsWorkspace"),
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
  const data = await gql<{
    project: ProjectNode & { services: Edges<ServiceNode> };
  }>(
    PROJECT_QUERY,
    { id: projectId },
    { accessToken, operationName: "Project", signal },
  );

  return {
    project: toProject(data.project),
    containers: toContainers(nodes(data.project.services), environmentId),
  };
}

export async function createContainer(
  accessToken: string,
  params: {
    projectId: string;
    environmentId: string;
    /** Already prefixed by the caller via toManagedName(). */
    name: string;
    image: string;
    /** Resolved by the caller from the preset catalog; never supplied by the browser. */
    variables?: Record<string, string>;
  },
  signal?: AbortSignal,
): Promise<{
  serviceId: string;
  deploymentId: string | null;
  /**
   * What happened after `serviceCreate` returned.
   *
   * Both failure values mean the same thing to the caller — the service exists and is not
   * running — but they are different sentences to a user and different lines in the audit
   * log, so they are not collapsed into a boolean. Reaching any of the three means a
   * service was created; only a throw from this function means none was.
   */
  outcome: "deployed" | "variables_failed" | "deploy_failed";
}> {
  const created = await gql<{ serviceCreate: { id: string; name: string } }>(
    SERVICE_CREATE_MUTATION,
    {
      input: {
        projectId: params.projectId,
        environmentId: params.environmentId,
        name: params.name,
        source: { image: params.image },
      },
    },
    { accessToken, operationName: "ServiceCreate", signal },
  );

  const serviceId = created.serviceCreate.id;

  /*
   * Variables BEFORE the deploy, never after.
   *
   * A postgres container started without POSTGRES_PASSWORD exits on its first tick and
   * Railway restarts it forever — the user watches a crash loop and reasonably concludes
   * this app is broken. Setting them afterwards would need a redeploy and would show that
   * crash loop first.
   *
   * A failure here deliberately does NOT deploy, for the same reason the comment below
   * gives: an un-deployed service is visible, prefixed and destroyable from the
   * dashboard, which is strictly better than a running container in a restart loop
   * nobody can diagnose.
   */
  if (params.variables && Object.keys(params.variables).length > 0) {
    try {
      await gql(
        VARIABLE_COLLECTION_UPSERT_MUTATION,
        {
          input: {
            projectId: params.projectId,
            environmentId: params.environmentId,
            serviceId,
            variables: params.variables,
            replace: false,
            /*
             * Railway redeploys a service when its variables change. The explicit deploy
             * below is the one this app tracks — it returns the deployment id the row's
             * log stream keys on — so a second, variable-triggered deployment would leave
             * the user watching logs from a deployment that is not the current one.
             */
            skipDeploys: true,
          },
        },
        { accessToken, operationName: "VariableCollectionUpsert", signal },
      );
    } catch (error) {
      // Names only. These are generated credentials, and this is the one log line in the
      // system that would otherwise be holding them.
      log.warn("railway.variables_failed", {
        service_id: serviceId,
        variable_names: Object.keys(params.variables).join(","),
        error,
      });
      return { serviceId, deploymentId: null, outcome: "variables_failed" };
    }
  }

  /*
   * serviceCreate registers the service; the deploy is a separate step. If this second
   * call fails the service exists but is not running, which the dashboard shows as an
   * un-deployed container the user can destroy — better than silently orphaning it.
   *
   * Caught for the same reason the variables call above is: a throw from here would carry
   * no service id, so the caller could not tell "nothing was created" from "a billable
   * service was created and left un-deployed", and would log neither. The classification
   * this discards from the user's sentence — auth, rate limit, outage — is entirely
   * preserved in the record below, incident id included.
   */
  let deployed: { serviceInstanceDeployV2: string | null };
  try {
    deployed = await gql<{ serviceInstanceDeployV2: string | null }>(
      SERVICE_DEPLOY_MUTATION,
      { serviceId, environmentId: params.environmentId },
      { accessToken, operationName: "ServiceInstanceDeployV2", signal },
    );
  } catch (error) {
    log.warn("railway.deploy_failed", { service_id: serviceId, error });
    return { serviceId, deploymentId: null, outcome: "deploy_failed" };
  }

  return {
    serviceId,
    deploymentId: deployed.serviceInstanceDeployV2 ?? null,
    outcome: "deployed",
  };
}

export async function destroyContainer(
  accessToken: string,
  serviceId: string,
  signal?: AbortSignal,
): Promise<void> {
  await gql<{ serviceDelete: boolean }>(
    SERVICE_DELETE_MUTATION,
    { id: serviceId },
    { accessToken, operationName: "ServiceDelete", signal },
  );
}

export async function getDeployment(
  accessToken: string,
  deploymentId: string,
  signal?: AbortSignal,
): Promise<{ id: string; status: string | null; updatedAt: string | null } | null> {
  const data = await gql<{
    deployment: {
      id: string;
      status: string | null;
      updatedAt: string | null;
    } | null;
  }>(
    DEPLOYMENT_QUERY,
    { id: deploymentId },
    { accessToken, operationName: "Deployment", signal },
  );
  return data.deployment;
}

/**
 * Backfill for the log pane, used on first attach and after a stream reconnect so a
 * dropped connection does not leave a hole in the output.
 */
export async function getLogs(
  accessToken: string,
  deploymentId: string,
  kind: "build" | "deploy",
  limit: number = STREAM.BACKFILL_LINES,
  signal?: AbortSignal,
): Promise<LogLine[]> {
  const isBuild = kind === "build";
  const data = await gql<Record<string, LogLine[] | null>>(
    isBuild ? BUILD_LOGS_QUERY : DEPLOYMENT_LOGS_QUERY,
    { deploymentId, limit },
    {
      accessToken,
      operationName: isBuild ? "BuildLogs" : "DeploymentLogs",
      signal,
    },
  );
  return data[isBuild ? "buildLogs" : "deploymentLogs"] ?? [];
}
