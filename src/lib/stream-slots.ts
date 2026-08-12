import "server-only";

import { STREAM } from "@/lib/constants";

/**
 * Caps how many log streams one user can hold open at once.
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
