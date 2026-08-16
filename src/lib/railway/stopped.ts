import "server-only";

import type { Container, DeploymentHistoryEntry } from "./types";

/**
 * Which containers this app stopped, and what Railway was saying when it did.
 *
 * **The problem.** `deploymentStop` returns `true`, Railway genuinely stops the container —
 * a SIGTERM is written to its own log — and `deployment.status` stays `SUCCESS`
 * indefinitely. There is no terminal status for a stopped deployment and no field anywhere
 * that says one is stopped. So `toContainerState` maps it to `running`, the row keeps
 * counting uptime through the downtime, and `availableActions("running")` offers Stop and
 * Restart — which means **Redeploy is structurally unreachable** on a container this app
 * just stopped. That is the bug this module exists for, measured against the live API.
 *
 * **What it does.** Remembers the stop, and the exact reading it was taken against. While a
 * later read still reports that same deployment at that same raw status, the app renders
 * `removed` instead of `running`. The moment Railway reports anything else, the memory goes.
 *
 * Four decisions, each because the obvious version of this is wrong:
 *
 * **Keyed by service, not by deployment.** Keying by deployment id looks self-correcting and
 * is not: `restartDeployment` keeps the same id, so a restart would leave the row stuck at
 * `removed` — and `availableActions("removed")` offers only Redeploy, so the container could
 * not be stopped again and pressing Redeploy would mint a second deployment of a running
 * one. A restart from Railway's own dashboard fails the same way. One entry per service,
 * replaced rather than accumulated, is the shape that cannot strand a row.
 *
 * **The raw status is part of the match, not just the id.** `DEPLOYING`, `CRASHED`,
 * `FAILED`, `REMOVED` all mean Railway has spoken since the stop, so the overlay stands
 * down. That is what makes a restart from outside this app correct, and what stops a crash
 * loop being masked by a stale memory of a stop.
 *
 * **No expiry, deliberately.** `watch-fingerprint.ts` hashes `container.state`, so an entry
 * that timed out would flip the fingerprint back, the watcher would push `changed`, and
 * every open tab would silently return to **Running** for a container that is still stopped.
 * The lie would reverse itself, unprompted, and broadcast the reversal. Bounded by size
 * instead, and cleared explicitly by `withManagedContainer` before any other verb runs.
 *
 * This is the third in-memory, per-replica store in this app, beside `idempotency.ts` and
 * `stream-slots.ts`, and the only one with no expiry — docs/limitations.md names it and
 * ADR-4 carries the paragraph that admits it. The consequence of a restart is a row that
 * reads `running` again, which is the pre-existing bug rather than a new one.
 */
type StoppedEntry = {
  deploymentId: string;
  /** Railway's own enum member at the moment of the stop — `SUCCESS`, in every case seen. */
  rawStatus: string | null;
  /**
   * When that deployment was created, which pins the entry to a deployment *instance*
   * rather than to an id.
   *
   * Free in production, where Railway's ids are UUIDs and never recycle — a stop's
   * deployment keeps this value, so it can never cause a false negative. It earns its
   * place against the e2e fixture, which resets its id counter on every spec while this
   * process does not: without it, an entry left by the spec that stops a container could
   * land on a different spec's first container, and render a running row as Removed.
   */
  deployedAt: string | null;
};

const stopped = new Map<string, StoppedEntry>();

/**
 * The ceiling that stands in for an expiry.
 *
 * Generous — a Railway account cannot hold this many services on any plan this app has met
 * — so in practice nothing is ever evicted, and the bound exists so an unbounded map cannot
 * be the thing that takes a long-lived replica down. Eviction is oldest-first, which `Map`
 * gives for free by insertion order.
 */
const MAX_ENTRIES = 500;

/** Record that this app stopped `serviceId`, against the reading it was stopped at. */
export function markStopped(serviceId: string, entry: StoppedEntry): void {
  // Delete-then-set so a re-stop moves the entry to the back of the insertion order, which
  // is what makes the eviction below oldest-first rather than first-ever-seen.
  stopped.delete(serviceId);
  stopped.set(serviceId, {
    deploymentId: entry.deploymentId,
    rawStatus: entry.rawStatus,
    deployedAt: entry.deployedAt,
  });
  if (stopped.size > MAX_ENTRIES) {
    const oldest = stopped.keys().next();
    if (!oldest.done) stopped.delete(oldest.value);
  }
}

/**
 * Forget any stop recorded for this service.
 *
 * Called from `withManagedContainer` for every verb but stop, so restart, redeploy,
 * rollback, edit and destroy are all covered by construction and a seventh verb cannot
 * forget to. It also closes the eventual-consistency window: right after a redeploy,
 * `latestDeployment` can still read the old id at the old status for a poll or two, and
 * without this the row would go on offering Redeploy — one more click, one more deployment.
 */
export function clearStopped(serviceId: string): void {
  stopped.delete(serviceId);
}

/** Test seam: the map is process-global and would otherwise leak across cases. */
export function __resetStopped(): void {
  stopped.clear();
}

/**
 * Apply the memory of a stop to a list Railway just answered with.
 *
 * A new array of new objects rather than a mutation, because the caller's list came out of
 * `toContainers` and is handed to a fingerprint and to React — both of which compare, and
 * neither of which should be reading an object something else edited.
 *
 * Applied at the two render call sites, `data-containers.ts` and the watch route, and
 * **not** inside `getProjectContainers`. Its other two callers — the ownership guard and the
 * bulk destroy path — both state their contract as acting on Railway's answer to this
 * request rather than on anything the app inferred, and overlaying inside the read would
 * make that sentence quietly false.
 *
 * `removed` is reused rather than a `stopped` state added. A tenth `ContainerState` member
 * would pull in the `[data-state-color]` block in globals.css, the contrast test that
 * asserts a token pair resolves for every member in both themes, the status badge, the
 * filter bar's options and the sort rank — and `removed` already means "not running, can be
 * redeployed" and already carries all of it. `rawStatus` is left alone on purpose: the badge
 * reads it out to screen readers as "Railway status: …", and Railway really did say SUCCESS.
 */
export function applyStopped(containers: Container[]): Container[] {
  if (stopped.size === 0) return containers;

  return containers.map((container) => {
    const entry = stopped.get(container.serviceId);
    if (!entry) return container;

    // Anything else from Railway supersedes the memory — including a different deployment,
    // which is a redeploy this app did not perform.
    if (
      entry.deploymentId !== container.deploymentId ||
      entry.rawStatus !== container.rawStatus ||
      entry.deployedAt !== container.deployedAt
    ) {
      stopped.delete(container.serviceId);
      return container;
    }

    if (container.state === "removed") return container;
    return { ...container, state: "removed" };
  });
}

/**
 * The same memory, applied to one service's deployment history.
 *
 * Without this the two surfaces contradict each other on the same screen: the row badge
 * reads **Removed** while the newest entry in the panel one scroll below reads **Running**,
 * because `toDeploymentHistory` is a second, independent producer of `ContainerState` from
 * the same raw status. Two readings of one deployment, and nothing to tell the user which
 * one to believe.
 *
 * **Read-only, unlike `applyStopped`.** It evicts nothing. A history is a list of past
 * deployments and all but one of them will fail to match by construction, so a mismatch
 * here means nothing at all — where in the container list it means Railway has spoken. The
 * list read stays the sole authority on when the memory is discarded.
 */
export function applyStoppedToHistory(
  serviceId: string,
  entries: DeploymentHistoryEntry[],
): DeploymentHistoryEntry[] {
  const stop = stopped.get(serviceId);
  if (!stop) return entries;

  return entries.map((entry) =>
    entry.id === stop.deploymentId &&
    entry.rawStatus === stop.rawStatus &&
    entry.createdAt === stop.deployedAt &&
    entry.state !== "removed"
      ? { ...entry, state: "removed" }
      : entry,
  );
}
