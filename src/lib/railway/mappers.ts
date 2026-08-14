import { isManagedName, stripPrefix } from "./managed";
import {
  toContainerState,
  type Container,
  type ContainerMetrics,
  type RailwayProject,
  type WorkspaceSpend,
} from "./types";

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

/** `me`, with every project source optional — each document selects only one of them. */
export type ViewerNode = {
  id: string;
  name?: string;
  email?: string;
  projects?: Edges<ProjectNode>;
  workspaces?: Array<{
    id: string;
    name?: string | null;
    projects?: Edges<ProjectNode>;
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
    const label = workspace.name ?? null;
    for (const node of nodes(workspace.projects)) {
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
    // The deployment's own creation, not the service's — uptime is measured from the
    // current deployment, and a service redeployed this morning is a month old.
    deployedAt: deployment?.createdAt ?? null,
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

export type MetricsResultNode = {
  measurement: string;
  tags: { serviceId: string | null } | null;
  values: Array<{ ts: number; value: number }> | null;
};

export type WorkspaceNode = {
  id: string;
  name?: string | null;
  customer?: {
    currentUsage: number;
    billingPeriod: { start: string; end: string } | null;
  } | null;
} | null;

/** The newest sample in a series, or null if Railway returned none. */
function newest(
  values: Array<{ ts: number; value: number }> | null,
): { ts: number; value: number } | null {
  /*
   * Max by `ts`, never `values.at(-1)`. Railway documents no ordering guarantee, and the
   * one number this app renders is the current one — reading the wrong end of an
   * unspecified order would show a five-minute-old figure that looks exactly like a
   * correct one.
   */
  let best: { ts: number; value: number } | null = null;
  for (const point of values ?? []) {
    if (!best || point.ts > best.ts) best = point;
  }
  return best;
}

/**
 * One `metrics` response, pivoted from measurement-major to service-major.
 *
 * Railway answers with one entry per (measurement, service) pair; the UI asks per row. The
 * pivot is here rather than in the component so the numbers cross the RSC boundary in the
 * shape they are read in.
 *
 * A Record rather than a Map, and that is not incidental: it crosses the RSC boundary as
 * plain JSON, and under `noUncheckedIndexedAccess` a lookup is `ContainerMetrics |
 * undefined` — which IS the row's "Railway said nothing about this container" state. The
 * type system hands that branch over rather than the component having to remember it.
 */
export function toContainerMetrics(
  results: MetricsResultNode[],
): Record<string, ContainerMetrics> {
  const byService: Record<string, ContainerMetrics> = {};

  for (const result of results) {
    const serviceId = result.tags?.serviceId;
    // Narrowed, not asserted. `MetricTags.serviceId` is nullable on the live schema, and a
    // result that names no service is one this app has no row to put anywhere.
    if (!serviceId) continue;

    const point = newest(result.values);
    /*
     * An empty `values` array is ORDINARY — a service with no running instance produces no
     * samples — so it maps to null and stays null. Never zero: "0.00 vCPU" claims the
     * container is running and idle, and "—" claims Railway said nothing. Those are
     * different sentences and the UI renders them differently.
     */
    if (!point) continue;

    const existing = byService[serviceId] ?? {
      serviceId,
      cpuCores: null,
      memoryGb: null,
      sampledAt: null,
    };

    switch (result.measurement) {
      case "CPU_USAGE":
        existing.cpuCores = point.value;
        break;
      case "MEMORY_USAGE_GB":
        existing.memoryGb = point.value;
        break;
      default:
        // Ignored rather than thrown, for the reason toContainerState gives for
        // DeploymentStatus: Railway adds enum members without notice, and a measurement
        // this app did not ask for must not take the readout down with it.
        continue;
    }

    existing.sampledAt = Math.max(existing.sampledAt ?? 0, point.ts);
    byService[serviceId] = existing;
  }

  return byService;
}

/**
 * The workspace's current-period spend, or null when there is none to show.
 *
 * Null covers two situations the caller does not need to tell apart: a personal project,
 * which belongs to no workspace at all, and a token whose scope does not reach `customer`.
 * From the reader's side they are the same — the figure lives on Railway, not here.
 */
export function toWorkspaceSpend(workspace: WorkspaceNode): WorkspaceSpend | null {
  const customer = workspace?.customer;
  const period = customer?.billingPeriod;
  if (!customer || !period) return null;

  return {
    currentUsage: customer.currentUsage,
    periodStart: period.start,
    periodEnd: period.end,
    workspaceName: workspace?.name ?? null,
  };
}
