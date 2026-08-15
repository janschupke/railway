import { isManagedName, stripPrefix } from "./managed";
import {
  toContainerState,
  type Container,
  type ContainerMetrics,
  type ContainerVolume,
  type RailwayProject,
  type RailwayWorkspace,
  type RegionOption,
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
    /**
     * Nullable here though the schema calls it `AllDomains!`, for the reason every other
     * member of this shape is: these types describe what a *response* may hold, not what
     * the schema promises, and a partial or malformed body is exactly when a mapper runs
     * against a field that is not there.
     */
    domains?: { serviceDomains: Array<{ domain: string }> } | null;
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
 * The workspaces the viewer can reach, as places a project could be created.
 *
 * Nameless entries are dropped rather than given a placeholder. `name` is nullable on the
 * live schema, and the only thing this list becomes is a select — a row with no accessible
 * name is not a choice a reader can make, and an id shown in its place is not one either.
 *
 * One pass for the same reason toRegionOptions gives: the null test and the read of the
 * value it narrows stay in one expression, so a later edit cannot pull them apart.
 *
 * Sorted, because Railway documents no ordering for this connection — the same argument
 * toPublicUrl makes about domains. An unordered list would reshuffle the picker between
 * two reads that found the same workspaces.
 */
export function toWorkspaces(viewer: ViewerNode): RailwayWorkspace[] {
  return (viewer.workspaces ?? [])
    .flatMap((workspace) =>
      workspace.name ? [{ id: workspace.id, name: workspace.name }] : [],
    )
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * The address a service answers on, or null if it has none.
 *
 * Sorted before choosing, and that is the whole reason this is a function rather than a
 * `[0]`. A service may carry several domains — Railway mints one per target port, and the
 * user may have added more in its own dashboard — and Railway documents no ordering for
 * the list. Reading whichever end the response happened to put first means two polls of an
 * unchanged service can disagree, which flips `fingerprint()` and wakes every open tab on
 * a change that did not happen.
 *
 * `https://` because Railway terminates TLS at its edge for the domains it mints and issues
 * the certificate itself; `ServiceDomain.domain` is the bare host, so the scheme is added
 * exactly here and nowhere downstream.
 */
function toPublicUrl(
  domains: { serviceDomains: Array<{ domain: string }> } | null | undefined,
): string | null {
  const hosts = (domains?.serviceDomains ?? [])
    .map((entry) => entry.domain)
    .filter((domain) => domain.length > 0)
    .sort();
  const first = hosts[0];
  return first ? `https://${first}` : null;
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
    url: toPublicUrl(instance.domains),
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
    /*
     * Dropped, and this is observed behaviour rather than defensive narrowing:
     * `pnpm probe:metrics` showed Railway returning one extra result per measurement
     * alongside the per-service ones, with `tags.serviceId: null` and a single `{ts, value}`
     * point. It is an aggregate across the grouping, and this app has no row to put it in —
     * keeping it would attribute the whole project's usage to a service under the empty key.
     *
     * `tags` being absent entirely is the separate, schema-derived case: `MetricTags` is
     * nullable and nothing has been seen to return it that way.
     */
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
      cpuLimitCores: null,
      memoryLimitGb: null,
      sampledAt: null,
    };

    switch (result.measurement) {
      case "CPU_USAGE":
        existing.cpuCores = point.value;
        existing.sampledAt = Math.max(existing.sampledAt ?? 0, point.ts);
        break;
      case "MEMORY_USAGE_GB":
        existing.memoryGb = point.value;
        existing.sampledAt = Math.max(existing.sampledAt ?? 0, point.ts);
        break;
      /*
       * The ceilings do not advance `sampledAt`. They are constant series — the same figure
       * at every timestamp — and the field is documented as when the usage was read. A
       * service whose limits arrived but whose usage did not still reports `sampledAt: null`,
       * which is the truthful answer to "how current is this reading".
       */
      case "CPU_LIMIT":
        existing.cpuLimitCores = point.value;
        break;
      case "MEMORY_LIMIT_GB":
        existing.memoryLimitGb = point.value;
        break;
      default:
        // Ignored rather than thrown, for the reason toContainerState gives for
        // DeploymentStatus: Railway adds enum members without notice, and a measurement
        // this app did not ask for must not take the readout down with it.
        continue;
    }

    byService[serviceId] = existing;
  }

  return byService;
}

export type VolumeInstanceNode = {
  id: string;
  volumeId: string;
  serviceId: string | null;
  mountPath: string;
  sizeMB: number;
  currentSizeMB: number;
};

/**
 * The volumes in one environment, keyed by the service each is mounted on.
 *
 * Keyed the same way and for the same reasons as `toContainerMetrics` above: it crosses the
 * RSC boundary as plain JSON, and `noUncheckedIndexedAccess` makes a lookup
 * `ContainerVolume | undefined`, which is precisely the row's "this container has no
 * volume" state rather than a branch a component has to remember.
 *
 * Two shapes are dropped on the way through, and neither is an error:
 *
 *   - **A null `serviceId`.** The field is nullable on the schema and a volume outlives the
 *     service it was mounted on, so this is an orphan — most often one left behind by a
 *     destroy where the user chose to keep the data. Real, billable, and not something this
 *     app has any surface for: it lists containers, and an orphan volume is not one. Railway's
 *     own project page is where it is visible, and README Limitations says so.
 *   - **A second volume on a service already seen.** Railway permits several, this app
 *     creates exactly one, and the first wins. Rendering "2 volumes" in a row that offers
 *     one mount path would be the readout describing a service this app did not create the
 *     way it describes one it did.
 */
export function toContainerVolumes(
  instances: VolumeInstanceNode[],
): Record<string, ContainerVolume> {
  const byService: Record<string, ContainerVolume> = {};

  for (const instance of instances) {
    const serviceId = instance.serviceId;
    if (!serviceId || byService[serviceId]) continue;

    byService[serviceId] = {
      serviceId,
      volumeId: instance.volumeId,
      mountPath: instance.mountPath,
      sizeMB: instance.sizeMB,
      currentSizeMB: instance.currentSizeMB,
    };
  }

  return byService;
}

export type RegionNode = {
  id: string | null;
  name: string;
  location: string;
  country: string;
  deploymentConstraints: { deprecationInfo: { isDeprecated: boolean } | null } | null;
};

/**
 * The regions worth offering, in the order a select should show them.
 *
 * Two filters, and each drops a row that would be a worse choice than no choice:
 *
 *   - **No `id`.** The field is nullable on Railway's own type while `name` and `location`
 *     are not, so a region can be listed with nothing to submit. An option posting the empty
 *     string is indistinguishable from the blank one above it, which means Railway picks —
 *     so the user would choose a region and silently get a different one.
 *   - **Deprecated.** Railway carries a replacement region beside the flag, so these are
 *     datacentres with an end date. Offering one is offering a container that stops working
 *     later, at a moment nothing in this app will explain.
 *
 * `location` rather than `name` as the label: `name` is the identifier again in most rows,
 * where `location` is the sentence a person reads. Sorted by country then label, because the
 * country is the `<optgroup>` heading and an unsorted list would repeat headings.
 */
export function toRegionOptions(regions: RegionNode[]): RegionOption[] {
  return (
    regions
      /*
       * One pass, because the guard and the read have to stay together. `id` is nullable on
       * the live schema, so this was a `.filter` for null followed four lines later by a
       * `.map` asserting non-null — two statements holding one invariant between them, and
       * the compiler checking neither. `flatMap` narrows `id` where it is tested and uses it
       * in the same expression, which is the same refusal expressed so that it cannot come
       * apart in a later edit.
       */
      .flatMap((region) =>
        region.id === null ||
        region.deploymentConstraints?.deprecationInfo?.isDeprecated
          ? []
          : [{ id: region.id, label: region.location, country: region.country }],
      )
      .sort(
        (left, right) =>
          left.country.localeCompare(right.country) ||
          left.label.localeCompare(right.label),
      )
  );
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
