import "server-only";

import { IDEMPOTENCY } from "@/lib/constants";

/** What `run` produced, and whether this key may serve it to a later caller. */
export type Retainable<T> = { value: T; retain: boolean };

type Entry = {
  result: Promise<Retainable<unknown>>;
  /** Epoch ms after which this entry stops being served. Infinite while in flight. */
  retainUntil: number;
};

/**
 * Which submission produced which result, keyed by `userId:idempotencyKey`.
 *
 * Why a key rather than the name check it replaced is ADR-12's argument and is not repeated
 * here. What this module is: the lock that argument concluded with. The entry is inserted
 * before the create is attempted, so a second caller finds it and is handed the first
 * caller's answer instead of making a second container.
 *
 * A settled entry is retained for IDEMPOTENCY.RETAIN_SECONDS rather than deleted, for the
 * same reason `grants` in ./auth/refresh.ts retains one: a repeat does not have to overlap
 * to be a repeat. Someone who saw a request appear to fail and pressed the button again is
 * the case this exists for, and they are slower than the wire.
 *
 * Retention is the CALLER's call, not this module's, because only the caller knows whether
 * anything now exists on Railway. A create that was refused outright must stay retryable —
 * caching that failure would turn one blip into five minutes of a form that will not work —
 * so it says `retain: false` and the entry goes. A rejection is deleted for the same
 * reason, which is `grants`' rule again.
 *
 * Keyed by user so one person's key can neither burn nor observe another's; the key alone
 * is client-supplied, and two browsers can mint whatever they like.
 *
 * In-memory, and per replica — see README Limitations. The consequence specific to this
 * map, and the reason it is named there: a rolling restart between the two halves of a
 * double submit creates two services. A much narrower window than the one this closes, but
 * not zero. Note that `next dev`'s module reloading resets the map; production does not.
 */
const entries = new Map<string, Entry>();

/** Drop entries whose retention window has closed. Lazy: no timer runs here. */
function sweep(nowMs: number): void {
  for (const [key, entry] of entries) {
    if (entry.retainUntil <= nowMs) entries.delete(key);
  }
}

/** Test seam: the map is process-global and would otherwise leak across cases. */
export function __resetIdempotency(): void {
  entries.clear();
}

/**
 * Run `run` once per key, and serve its result to every later caller inside the window.
 *
 * `replayed` says which side of that the caller is on. It is not a detail the caller can
 * derive — the value is identical either way, deliberately — and the two want different
 * things from it: the audit trail records a replay, and a caller that ran nothing still
 * needs its own `revalidatePath`.
 */
export async function runOnce<T>(
  key: string,
  run: () => Promise<Retainable<T>>,
  now: () => number = Date.now,
): Promise<{ value: T; replayed: boolean }> {
  sweep(now());

  const existing = entries.get(key);
  if (existing) {
    const { value } = (await existing.result) as Retainable<T>;
    return { value, replayed: true };
  }

  /*
   * Synchronous from the miss above to the set below, and it has to stay that way. This
   * is the whole lock: Node runs one thing at a time, so a second submission cannot
   * observe the map between the two. Awaiting `run()` here instead of storing its promise
   * would reopen exactly the window this module exists to close.
   */
  const pending = run();
  const entry: Entry = { result: pending, retainUntil: Number.POSITIVE_INFINITY };
  entries.set(key, entry);

  /*
   * `.then(ok, err)` rather than `.finally`: the two branches differ, and passing a
   * rejection handler here means this bookkeeping never registers an unhandled rejection
   * of its own. The identity check keeps a settling promise from touching an entry that a
   * later call has already replaced under the same key.
   */
  pending.then(
    (settled) => {
      if (entries.get(key) !== entry) return;
      if (settled.retain) {
        entry.retainUntil = now() + IDEMPOTENCY.RETAIN_SECONDS * 1000;
      } else {
        entries.delete(key);
      }
    },
    () => {
      if (entries.get(key) === entry) entries.delete(key);
    },
  );

  const { value } = await pending;
  return { value, replayed: false };
}
