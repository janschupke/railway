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
   * all this app creates (ADR-6). Stated in README Limitations rather than rounded away.
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
  /** Unix seconds of the newest sample these values came from. */
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
 * `id` is `String!` here and nullable on Railway's own type. That narrowing is the mapper's
 * job and it is the reason the mapper exists at all: a region with no id is a row that would
 * post an empty string, which reads as "let Railway choose" rather than as the choice the
 * person made.
 */
export type RegionOption = {
  /** The airport code the mutation takes, e.g. `us-west2`. */
  id: string;
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
