import "server-only";

import { STREAM } from "@/lib/constants";

/**
 * Caps how many of something one user may have at once.
 *
 * Three budgets share this map, under keys their callers namespace: log streams, project
 * watchers, and in-flight image checks. The reasoning below is the log stream's, which is
 * the expensive one; the other two take the mechanism rather than the argument.
 *
 * What it bounds is **simultaneity, not rate**. A caller released at the end of every
 * request can make as many serial requests as upstream will answer — the image check's
 * shared answer cache and per-registry cool-off are what bound that one, and a reader who
 * mistakes this for a rate limit will look for a guarantee it does not make.
 *
 * Each stream costs a held HTTP response, an upstream WebSocket to Railway, and a
 * status poll every few seconds for up to the duration ceiling — so an unbounded
 * endpoint lets one session exhaust this process's sockets and burn the account's
 * Railway rate limit at the same time. There was no cap at all.
 *
 * In-memory, and per replica. That is honest rather than lazy: SSE pins a client to one
 * replica, which is why the README already describes this as a single-replica app. If
 * that ever changes, this needs to move to shared state along with everything else.
 *
 * Note that `next dev`'s module reloading resets the map; production does not.
 */
const active = new Map<string, number>();

/**
 * Takes a slot, or returns null when the user is already at the cap.
 *
 * The returned release is self-guarding, so callers can wire it to a teardown path that
 * may fire more than once without double-counting.
 */
export function acquireStreamSlot(
  userId: string,
  limit: number = STREAM.MAX_CONCURRENT_PER_USER,
): (() => void) | null {
  const held = active.get(userId) ?? 0;
  if (held >= limit) return null;

  active.set(userId, held + 1);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (active.get(userId) ?? 1) - 1;
    // Delete at zero so an idle user leaves no residue behind in the map.
    if (next <= 0) active.delete(userId);
    else active.set(userId, next);
  };
}

/** Test-only view of the counter; nothing in the app needs to read it. */
export function activeStreamCount(userId: string): number {
  return active.get(userId) ?? 0;
}
