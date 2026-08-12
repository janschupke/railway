import { isManagedName, stripPrefix } from "./managed";
import { toContainerState, type Container, type RailwayProject } from "./types";

/** Railway's API is Relay-style; almost every list arrives wrapped like this. */
export type Edges<T> = { edges: Array<{ node: T }> } | null | undefined;

export const nodes = <T>(connection: Edges<T>): T[] =>
  connection?.edges?.map((edge) => edge.node) ?? [];

export type ProjectNode = {
  id: string;
  name: string;
  environments: Edges<{ id: string; name: string }>;
};

export type ServiceNode = {
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

/** `me`, with both project sources optional — the fallback query selects only one. */
export type ViewerNode = {
  id: string;
  name?: string;
  email?: string;
  projects?: Edges<ProjectNode>;
  workspaces?: Array<{
    id: string;
    name?: string | null;
    /** Null for a personal workspace, which has no team behind it. */
    team?: { id: string; name?: string | null; projects: Edges<ProjectNode> } | null;
  }> | null;
};

export function toProject(node: ProjectNode): RailwayProject {
  return {
    id: node.id,
    name: node.name,
    environments: nodes(node.environments).map((e) => ({ id: e.id, name: e.name })),
  };
}

/**
 * Every project on the viewer, de-duplicated by id.
 *
 * A project reachable both personally and through a workspace appears in both
 * connections; showing it twice in the picker would be a worse bug than the empty list
 * this exists to fix. Personal entries win, so a project the user owns is never labelled
 * with someone else's workspace.
 */
export function toProjects(viewer: ViewerNode): RailwayProject[] {
  const byId = new Map<string, RailwayProject>();

  for (const node of nodes(viewer.projects)) {
    if (!byId.has(node.id)) byId.set(node.id, toProject(node));
  }

  for (const workspace of viewer.workspaces ?? []) {
    // The workspace's own name is the fallback: `team` is null for a personal workspace.
    const label = workspace.team?.name ?? workspace.name ?? null;
    for (const node of nodes(workspace.team?.projects)) {
      if (byId.has(node.id)) continue;
      byId.set(node.id, {
        ...toProject(node),
        ...(label ? { workspaceName: label } : {}),
      });
    }
  }

  return [...byId.values()];
}

/**
 * A service as it appears in one environment, or null if it does not exist there.
 *
 * `managed` is the ownership decision the whole destructive path depends on — it is
 * derived here from the name prefix and nowhere else.
 */
export function toContainer(
  service: ServiceNode,
  environmentId: string,
): Container | null {
  const instance = nodes(service.serviceInstances).find(
    (i) => i.environmentId === environmentId,
  );
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
}

/** Managed containers first, then newest — the ones the user can act on lead. */
export function sortContainers(containers: Container[]): Container[] {
  return [...containers].sort((a, b) => {
    if (a.managed !== b.managed) return a.managed ? -1 : 1;
    return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
  });
}

export function toContainers(
  services: ServiceNode[],
  environmentId: string,
): Container[] {
  const mapped = services
    .map((service) => toContainer(service, environmentId))
    .filter((c): c is Container => c !== null);
  return sortContainers(mapped);
}
