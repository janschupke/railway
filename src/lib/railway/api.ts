import "server-only";

import { gql } from "./client";
import {
  DEPLOYMENT_LOGS_QUERY,
  DEPLOYMENT_QUERY,
  BUILD_LOGS_QUERY,
  PROJECTS_QUERY,
  PROJECT_QUERY,
  SERVICE_CREATE_MUTATION,
  SERVICE_DELETE_MUTATION,
  SERVICE_DEPLOY_MUTATION,
} from "./operations";
import { isManagedName, stripPrefix } from "./managed";
import {
  toContainerState,
  type Container,
  type LogLine,
  type RailwayProject,
} from "./types";

type Edges<T> = { edges: Array<{ node: T }> } | null | undefined;

const nodes = <T>(connection: Edges<T>): T[] =>
  connection?.edges?.map((e) => e.node) ?? [];

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
      projects: Edges<{
        id: string;
        name: string;
        environments: Edges<{ id: string; name: string }>;
      }>;
    };
  }>(PROJECTS_QUERY, {}, { accessToken, operationName: "Projects", signal });

  return {
    viewer: { id: data.me.id, name: data.me.name, email: data.me.email },
    projects: nodes(data.me.projects).map((p) => ({
      id: p.id,
      name: p.name,
      environments: nodes(p.environments).map((e) => ({ id: e.id, name: e.name })),
    })),
  };
}

type ServiceNode = {
  id: string;
  name: string;
  createdAt: string | null;
  serviceInstances: Edges<{
    id: string;
    environmentId: string;
    source: { image: string | null; repo: string | null } | null;
    latestDeployment: {
      id: string;
      status: string | null;
      createdAt: string | null;
      updatedAt: string | null;
    } | null;
  }>;
};

/**
 * Everything the dashboard needs for one project, in a single request.
 *
 * Services created outside this app are returned too, marked `managed: false`. They are
 * shown for context — an accurate picture of the environment matters — but the UI
 * refuses to destroy them.
 */
export async function getProjectContainers(
  accessToken: string,
  projectId: string,
  environmentId: string,
  signal?: AbortSignal,
): Promise<{ project: RailwayProject; containers: Container[] }> {
  const data = await gql<{
    project: {
      id: string;
      name: string;
      environments: Edges<{ id: string; name: string }>;
      services: Edges<ServiceNode>;
    };
  }>(
    PROJECT_QUERY,
    { id: projectId },
    { accessToken, operationName: "Project", signal },
  );

  const project: RailwayProject = {
    id: data.project.id,
    name: data.project.name,
    environments: nodes(data.project.environments).map((e) => ({
      id: e.id,
      name: e.name,
    })),
  };

  const containers = nodes(data.project.services)
    .map<Container | null>((service) => {
      const instance = nodes(service.serviceInstances).find(
        (i) => i.environmentId === environmentId,
      );
      // The service exists in the project but not in the selected environment.
      if (!instance) return null;

      const deployment = instance.latestDeployment;
      return {
        serviceId: service.id,
        rawName: service.name,
        displayName: stripPrefix(service.name),
        image: instance.source?.image ?? null,
        repo: instance.source?.repo ?? null,
        state: toContainerState(deployment?.status),
        rawStatus: deployment?.status ?? null,
        deploymentId: deployment?.id ?? null,
        createdAt: service.createdAt,
        updatedAt: deployment?.updatedAt ?? null,
        managed: isManagedName(service.name),
      };
    })
    .filter((c): c is Container => c !== null)
    .sort((a, b) => {
      // Managed containers first, then newest.
      if (a.managed !== b.managed) return a.managed ? -1 : 1;
      return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
    });

  return { project, containers };
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
    deployment: { id: string; status: string | null; updatedAt: string | null } | null;
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
  limit = 200,
  signal?: AbortSignal,
): Promise<LogLine[]> {
  const query = kind === "build" ? BUILD_LOGS_QUERY : DEPLOYMENT_LOGS_QUERY;
  const data = await gql<Record<string, LogLine[] | null>>(
    query,
    { deploymentId, limit },
    {
      accessToken,
      operationName: kind === "build" ? "BuildLogs" : "DeploymentLogs",
      signal,
    },
  );
  return data[kind === "build" ? "buildLogs" : "deploymentLogs"] ?? [];
}
