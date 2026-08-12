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

/** No further transitions expected — the log stream can close. */
export function isTerminal(state: ContainerState): boolean {
  return state === "running" || state === "failed" || state === "removed";
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

export type RailwayEnvironment = {
  id: string;
  name: string;
};

export type RailwayProject = {
  id: string;
  name: string;
  environments: RailwayEnvironment[];
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
