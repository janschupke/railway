import "server-only";

import { STREAM } from "@/lib/constants";
import { gql } from "./client";
import {
  BUILD_LOGS_QUERY,
  DEPLOYMENT_LOGS_QUERY,
  DEPLOYMENT_QUERY,
  PROJECTS_QUERY,
  PROJECT_QUERY,
  SERVICE_CREATE_MUTATION,
  SERVICE_DELETE_MUTATION,
  SERVICE_DEPLOY_MUTATION,
} from "./operations";
import {
  nodes,
  toContainers,
  toProject,
  type Edges,
  type ProjectNode,
  type ServiceNode,
} from "./mappers";
import type { Container, LogLine, RailwayProject } from "./types";

export type Viewer = { id: string; name?: string; email?: string };

export async function listProjects(
  accessToken: string,
  signal?: AbortSignal,
): Promise<{ viewer: Viewer; projects: RailwayProject[] }> {
  const data = await gql<{
    me: {
      id: string;
      name?: string;
      email?: string;
      projects: Edges<ProjectNode>;
    };
  }>(PROJECTS_QUERY, {}, { accessToken, operationName: "Projects", signal });

  return {
    viewer: { id: data.me.id, name: data.me.name, email: data.me.email },
    projects: nodes(data.me.projects).map(toProject),
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
  },
  signal?: AbortSignal,
): Promise<{ serviceId: string; deploymentId: string | null }> {
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
   * serviceCreate registers the service; the deploy is a separate step. If this second
   * call fails the service exists but is not running, which the dashboard shows as an
   * un-deployed container the user can destroy — better than silently orphaning it.
   */
  const deployed = await gql<{ serviceInstanceDeployV2: string | null }>(
    SERVICE_DEPLOY_MUTATION,
    { serviceId, environmentId: params.environmentId },
    { accessToken, operationName: "ServiceInstanceDeployV2", signal },
  );

  return { serviceId, deploymentId: deployed.serviceInstanceDeployV2 ?? null };
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
