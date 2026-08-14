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
  /** Whether this app created the service, and may therefore destroy it. */
  managed: boolean;
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
