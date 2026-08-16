/**
 * Railway's `DeploymentStatus` enum, collapsed into a state machine the UI can render
 * without leaking backend vocabulary into components.
 *
 * Unknown values map to "unknown" rather than throwing — Railway can add enum members
 * at any time and a new status must not blank the dashboard.
 */
export const CONTAINER_STATES = [
  "pending",
  "building",
  "deploying",
  "running",
  "failed",
  "sleeping",
  "removing",
  "removed",
  "unknown",
] as const;

export type ContainerState = (typeof CONTAINER_STATES)[number];

const STATUS_MAP: Record<string, ContainerState> = {
  QUEUED: "pending",
  WAITING: "pending",
  INITIALIZING: "pending",
  NEEDS_APPROVAL: "pending",
  BUILDING: "building",
  DEPLOYING: "deploying",
  SUCCESS: "running",
  FAILED: "failed",
  CRASHED: "failed",
  SLEEPING: "sleeping",
  REMOVING: "removing",
  REMOVED: "removed",
  SKIPPED: "removed",
};

export function toContainerState(status: string | null | undefined): ContainerState {
  if (!status) return "unknown";
  return STATUS_MAP[status.toUpperCase()] ?? "unknown";
}

/**
 * No further transitions expected — the log stream can close.
 *
 * `sleeping` belongs here: a sleeping deployment has settled, and it used to be in
 * neither this predicate nor `isTransitioning`, so the monitor never emitted `done`, the
 * stream ran to the fifteen-minute ceiling, closed with no frame, and the browser
 * redialled it — a silent fifteen-minute cycle holding a poll and an upstream socket.
 *
 * `unknown` is deliberately still in neither. It means Railway sent an enum member this
 * app does not model, and closing a stream on that guess would go wrong the week they add
 * one. The monitor bounds it by poll count instead — see STREAM.UNSETTLED_POLLS_BEFORE_STOP.
 */
export function isTerminal(state: ContainerState): boolean {
  return (
    state === "running" ||
    state === "failed" ||
    state === "removed" ||
    state === "sleeping"
  );
}

/** Work is in flight; the UI shows motion and keeps the stream open. */
export function isTransitioning(state: ContainerState): boolean {
  return (
    state === "pending" ||
    state === "building" ||
    state === "deploying" ||
    state === "removing"
  );
}

/**
 * Railway's `DeploymentEventStep`, mirrored so the catalog can be keyed on it.
 *
 * The same reasoning `toContainerState` states for `DeploymentStatus`: these are upstream
 * enum members, Railway can add one at any time, and an eleventh must degrade rather than
 * render a missing-message marker. `isDeploymentStep` is the narrowing that makes
 * `t(\`deploymentStep.${step}\`)` safe — a member this app does not know falls back to the
 * branch that names no step at all.
 *
 * Ordered as a deployment walks them, not alphabetically, so a reader can see where in the
 * lifecycle a given failure sits.
 */
export const DEPLOYMENT_STEPS = [
  "SNAPSHOT_CODE",
  "BUILD_IMAGE",
  "PUBLISH_IMAGE",
  "WAIT_FOR_DEPENDENCIES",
  "MIGRATE_VOLUMES",
  "CREATE_CONTAINER",
  "PRE_DEPLOY_COMMAND",
  "CONFIGURE_NETWORK",
  "HEALTHCHECK",
  "DRAIN_INSTANCES",
] as const;

export type DeploymentStep = (typeof DEPLOYMENT_STEPS)[number];

export function isDeploymentStep(value: unknown): value is DeploymentStep {
  return (
    typeof value === "string" && (DEPLOYMENT_STEPS as readonly string[]).includes(value)
  );
}

export type RailwayEnvironment = {
  id: string;
  name: string;
};

export type RailwayProject = {
  id: string;
  name: string;
  environments: RailwayEnvironment[];
  /**
   * Set only for a project reached through a workspace rather than the viewer's own
   * project list. The picker groups by it, so two workspaces with a "web" project each
   * stay tellable apart; absent for personal projects, which then render ungrouped.
   */
  workspaceName?: string;
};

/**
 * A workspace the viewer can reach, as somewhere a new project could be created.
 *
 * Carries the id, which `RailwayProject.workspaceName` above deliberately does not: that
 * field labels a project the app has been handed, and this one names a destination the app
 * has to send back. They come out of the same `me.workspaces` read.
 */
export type RailwayWorkspace = {
  id: string;
  name: string;
};

export type Container = {
  serviceId: string;
  /** Name as shown in Railway, including the ownership prefix. */
  rawName: string;
  /** Name with the ownership prefix stripped, for display. */
  displayName: string;
  /** Docker image, when the service was created from one. */
  image: string | null;
  /** Git repo, when the service was created from one — see ADR-3. */
  repo: string | null;
  state: ContainerState;
  rawStatus: string | null;
  deploymentId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /**
   * When the current deployment was created, which is what uptime is measured from.
   *
   * Distinct from `createdAt`, which is the *service* — a service redeployed this morning
   * has been around for a month. Railway exposes no started-at anywhere, so this counts the
   * build and the deploy as uptime: seconds of overstatement for an image source, which is
   * all this app creates (ADR-6). Stated in docs/limitations.md rather than rounded away.
   */
  deployedAt: string | null;
  /**
   * Where this container answers on the public internet, or null if nowhere.
   *
   * On `Container` rather than keyed beside the list, which is the opposite of the choice
   * `ContainerMetrics` and `ContainerVolume` below make — and it is the same test that
   * decides both. `fingerprint()` hashes a `Container[]`, so what must stay out is anything
   * that MOVES: a CPU float, a byte counter. A service domain is minted once and then reads
   * the same on every poll for the life of the service, so it costs the watcher nothing and
   * belongs where the row already has it.
   *
   * It is also the field that most needs to be here. The URL first exists during the
   * `router.refresh()` after a spin-up, and a value the refresh does not carry is a value
   * the row cannot show until the next full navigation.
   *
   * Includes the scheme. Railway serves its own domains over TLS and issues the certificate
   * itself, so this is always `https://…` — see `toContainer`.
   */
  url: string | null;
  /** Whether this app created the service, and may therefore destroy it. */
  managed: boolean;
};

/**
 * One entry in a service's deployment history, as offered by the rollback control.
 *
 * Four fields, and the absent fifth is the point: **there is no image here**.
 * `Deployment.meta` is an opaque `scalar`, so Railway will not say what a given deployment
 * ran, and a row therefore identifies itself by when it happened and how it ended — "the
 * deployment from 14:32 that succeeded". That is the honest form of the choice, and it is a
 * narrower limitation than the one this app used to state.
 *
 * `canRollback` is Railway's answer, not a rule derived here, in the same way `canRedeploy`
 * is. The panel renders an entry it says no to rather than dropping it, so the absence of the
 * control is visible instead of the entry being missing.
 *
 * Not a field on `Container` and not keyed beside the list: this is read once, when someone
 * opens a panel, and it must stay out of `fingerprint()` for the reason `ContainerMetrics`
 * gives below — a history that grows on every redeploy would announce a change to every open
 * tab.
 */
export type DeploymentHistoryEntry = {
  id: string;
  state: ContainerState;
  /** Railway's own enum member, for the badge's title — see StatusBadge. */
  rawStatus: string | null;
  createdAt: string | null;
  canRollback: boolean;
};

/**
 * What one container is currently using, as of the newest sample Railway returned.
 *
 * Deliberately NOT a field on `Container`, and the reason is load-bearing rather than
 * stylistic: `fingerprint()` hashes a `Container[]` to decide whether to tell every open tab
 * to refresh. A CPU float in that hash differs on every poll, so the watcher would announce
 * a change every fifteen seconds forever, at two Railway round trips a time. The `updatedAt`
 * exclusion in watch-fingerprint.ts is the same trade, and it shows how easy that exclusion
 * is to forget — keeping metrics in a separate structure makes it structural instead of
 * remembered, because fingerprint cannot see a value it is never handed.
 *
 * `sortContainers`, `filterContainers` and `filterKey` are the same argument one layer up:
 * none of them should observe a value that changes every two minutes, and `filterKey`
 * resets the list's page count when it does.
 */
export type ContainerMetrics = {
  serviceId: string;
  /** vCPU. Null when Railway returned no sample, which is not the same as zero. */
  cpuCores: number | null;
  /** Gigabytes — Railway's own unit (MEMORY_USAGE_GB), never round-tripped through bytes. */
  memoryGb: number | null;
  /**
   * The ceilings the two figures above are measured against, from `CPU_LIMIT` and
   * `MEMORY_LIMIT_GB` in the same response.
   *
   * These do NOT move, so unlike the usage figures they would be safe inside `fingerprint()`
   * — which is exactly why the reason they are here needs writing down rather than leaving
   * to whoever reads the paragraph above and concludes they belong on `Container`. The
   * reason is not the hash: they arrive in this response, beside the usage they qualify, and
   * putting them on `Container` would mean a second read off `ServiceInstance` for a value
   * that changes only when someone edits the service.
   *
   * What Railway is enforcing, which is not necessarily what the spin-up form asked for — a
   * plan that clamps the request reports the clamped figure here, and that is the more useful
   * number to show. docs/limitations.md says so.
   */
  cpuLimitCores: number | null;
  memoryLimitGb: number | null;
  /**
   * Unix seconds of the newest sample the USAGE values came from.
   *
   * Advanced off `CPU_USAGE` and `MEMORY_USAGE_GB` only. A limit series carries timestamps
   * too, but a constant is not a sample of anything, and letting one move this would make the
   * field silently stop meaning what this line says.
   */
  sampledAt: number | null;
};

/**
 * The volume one container's data is written to.
 *
 * Kept out of `Container` for exactly the reason `ContainerMetrics` above is, and the
 * argument is worth reading there before moving this: `fingerprint()` hashes a
 * `Container[]` to decide whether to tell every open tab to refresh, and `currentSizeMB`
 * grows as the database is written to. A byte counter inside that hash would announce a
 * change on every poll forever, at two Railway round trips a time — which is the bug the
 * `updatedAt` exclusion in watch-fingerprint.ts had to be written to avoid. Keyed beside
 * the list instead, where `fingerprint` cannot see it.
 *
 * `mountPath` and `sizeMB` are stable and would be safe in the hash; splitting one type in
 * two to put them there would trade a real structural guarantee for nothing.
 */
export type ContainerVolume = {
  serviceId: string;
  /** What `volumeDelete` takes. Not the volume *instance* id, which is per environment. */
  volumeId: string;
  /** Absolute path inside the container, as the preset catalog asked for it. */
  mountPath: string;
  /** Provisioned size. Railway's plan default; this app cannot set it. */
  sizeMB: number;
  /** In use right now. Moves under the reader — see above. */
  currentSizeMB: number;
};

/**
 * One place a container can be created in, as the form offers it.
 *
 * Three fields where Railway's `Region` has six, and the two dropped ones say what this is
 * for: `region` is a grouping Railway uses internally and `workspaceId` is scoping the query
 * already did. What is left is what a select needs — the value it posts, the sentence it
 * shows, and the heading it sits under.
 *
 * **`value` carries Railway's `id`, the airport code, and there is one option per code.**
 * The field is named `value` rather than `id` because it is not a primary key and several
 * of Railway's rows share it: it is the string a select posts, and `toRegionOptions` is
 * where the argument for that lives, measured against real deployments.
 */
export type RegionOption = {
  /** Railway's own unit of placement — an airport code, e.g. `ams`. */
  value: string;
  /** Railway's own human string, e.g. "US West (Oregon)". */
  label: string;
  /** The `<optgroup>` heading. Railway's own country name, not a code. */
  country: string;
};

/**
 * Current-period spend, for the workspace a project belongs to.
 *
 * The scope is in the type name on purpose. This figure covers every service in the
 * workspace, including ones this app did not create, and there is no per-project or
 * per-service dollar amount anywhere in Railway's schema — `estimatedUsage` returns GB and
 * vCPU, and the only monetary fields are on `Customer` and `CustomerSubscription`, both of
 * which hang off a workspace. A component that renders this has to say so.
 */
export type WorkspaceSpend = {
  currentUsage: number;
  periodStart: string;
  periodEnd: string;
  workspaceName: string | null;
};

export type LogLine = {
  timestamp: string;
  message: string;
  severity?: string | null;
};

/**
 * Which of Railway's two log subscriptions a deployment is read through.
 *
 * Lives here rather than beside the monitor because the client picks it too — the row
 * decides from the state it can see, and the monitor is `server-only`.
 */
export type LogPhase = "build" | "deploy";
