import type { LogLine } from "./railway/types";

/**
 * Cancelling log lines this app has already shown, without deleting output a container
 * really produced twice.
 *
 * A deployment's history reaches the pane from two sources that overlap by design:
 * `getLogs()` backfills up to STREAM.BACKFILL_LINES on every attach so a reader joining
 * mid-build does not start at an empty pane, and the subscription opened straight after
 * it replays whatever history Railway holds. Every reconnect and every build→deploy
 * re-dial backfills again. Nothing cancelled any of it, so three lines could be shown
 * nine times.
 *
 * THE CONSTRAINT THIS WHOLE FILE IS SHAPED BY: a LogLine has no identity.
 * `{ timestamp, message, severity }` is not a key. Two identical lines in the same
 * millisecond are ordinary output — a progress dot, a retried layer pull, a health check
 * printing the same sentence — and a Set of serialized lines would silently delete the
 * second one. That is a worse bug than the one being fixed, because it is invisible: a
 * duplicate is untidy and a reader can see it, a missing line is a lie and they cannot.
 *
 * So every cancel here is POSITIONAL. It removes a contiguous run at the join between two
 * sources, in order, and never asks "have I seen this line anywhere before".
 *
 * Railway's `Log` really does carry no key: `{ attributes, message, severity, tags,
 * timestamp }`, with `tags` naming the deployment rather than the line. Read off the
 * committed schema, and printed by `pnpm probe:logs`. If one ever appears, throw all of
 * this away and key on it — that would be strictly better.
 *
 * Pure and React-free: the two callers are a `server-only` module (the monitor) and a
 * client hook, and neither can import the other.
 */

/**
 * Whether two lines are the same line.
 *
 * One implementation, deliberately: this predicate IS the no-identity constraint, and a
 * second copy somewhere else is a second place for a future `line.id` to be half-added.
 *
 * `severity` is compared with undefined folded into null, because the two mean the same
 * thing — the subscription omits the field and the query answers null for it, so the same
 * line arriving through both routes must compare equal or nothing here cancels at all.
 */
export function sameLine(a: LogLine, b: LogLine): boolean {
  return (
    a.timestamp === b.timestamp &&
    a.message === b.message &&
    (a.severity ?? null) === (b.severity ?? null)
  );
}

/**
 * The largest k where the last k lines of `prior` are the first k lines of `next`.
 *
 * LARGEST, not first — and the asymmetry with `expectReplay` below is the point. Both
 * sides here are the same query against the same source moments apart, so anything they
 * share is one contiguous run at the join by construction: `next` is a strictly more
 * recent window over the same history. Taking the largest k is therefore not a guess, it
 * is reading the window offset off the data.
 *
 * Zero when they share nothing, which is the ordinary answer for a long gap or for two
 * different phases.
 */
export function overlapLength(
  prior: readonly LogLine[],
  next: readonly LogLine[],
): number {
  for (let k = Math.min(prior.length, next.length); k > 0; k--) {
    let matched = true;
    for (let i = 0; i < k; i++) {
      /*
       * Both indices are bounded by the loops above — `k` starts at the shorter length and
       * `i` stays under it — so neither read can miss. Asserted rather than narrowed
       * because this is the inner loop of an O(n²) scan over a log buffer, and a pair of
       * undefined checks per iteration would be runtime cost for a state the two `for`
       * headers have already excluded. The rule is on; this is one of the four places in
       * `src/lib` that says why it is being stepped around.
       */
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- bounded by k
      if (!sameLine(prior[prior.length - k + i]!, next[i]!)) {
        matched = false;
        break;
      }
    }
    if (matched) return k;
  }
  return 0;
}

/**
 * Cancels a re-attach's backfill against what the buffer already holds.
 *
 * `lines` is `prior ++ backfill` and `backfilled` is the length of that trailing backfill,
 * which the SSE `ready` frame carries. The caller does not have to have kept the two
 * halves apart: `ready` arrives after its own backfill lines and before any subscription
 * line, so the split is exactly where `backfilled` says it is.
 *
 * What survives is the union in reading order. The reconnect case is the one to keep in
 * mind: a buffer that stops at line 7 and a backfill running 6→12 must end up 1→12, with
 * 6 and 7 shown once. Cancelling the *whole* backfill would reopen the gap the backfill
 * exists to close.
 *
 * Returns the input array by identity when nothing cancels, so the common case does not
 * hand a client a fresh array to re-render.
 *
 * Generic over the element, so the browser's `BufferedLine` keeps the id it minted on the
 * way in. `sameLine` reads only the three wire fields, which is what makes that safe: a
 * re-attach mints fresh ids for lines it has already shown, and comparing them would find
 * every pair different.
 */
export function dropReattachOverlap<T extends LogLine>(
  lines: T[],
  backfilled: number,
): T[] {
  /*
   * A count that cannot describe this buffer is ignored rather than clamped. It means the
   * frame and the buffer disagree about what happened — a `ready` for a stream whose lines
   * were already discarded, say — and guessing at a split point there would cancel real
   * output at an arbitrary position.
   */
  if (backfilled <= 0 || backfilled >= lines.length) return lines;

  const split = lines.length - backfilled;
  const prior = lines.slice(0, split);
  const backfill = lines.slice(split);
  const k = overlapLength(prior, backfill);
  if (k === 0) return lines;
  return [...prior, ...backfill.slice(k)];
}

/**
 * Whether one line arriving from the subscription is the backfill being replayed.
 *
 * Returns true when the line must NOT be shown again. A guard is single-use and stateful:
 * it is armed with the lines the backfill just emitted, and it disarms itself for good
 * the moment the replay ends, diverges, or fails to start.
 */
export type ReplayGuard = (line: LogLine) => boolean;

/**
 * How many non-matching subscription lines a guard tolerates before deciding no replay is
 * coming.
 *
 * One, because a replay that happens at all happens immediately: Railway sends the most
 * recent 100 lines in a burst before any live output, measured on 2026-08-14. Scanning
 * further is not free — it keeps the guard live while genuinely new output is arriving, and
 * a container that prints the same progress dot a minute later would then have that dot
 * swallowed as a "replay".
 *
 * Production passes STREAM.REPLAY_SCAN_LINES rather than relying on this; the default is
 * what the probe and the tests use, and the two numbers say the same thing.
 */
const DEFAULT_REPLAY_BUDGET = 1;

/**
 * Arms a replay guard against the lines a backfill has just put on the wire.
 *
 * Tracks EVERY alignment still consistent with what has arrived, rather than committing to
 * one. That is the whole design, and a single anchor is what it replaced: with three
 * identical progress dots at the end of the backfill, picking the last occurrence left the
 * cursor at the end of the history and every remaining replayed line leaked as a
 * duplicate; picking the first left it too early and the next line diverged. Neither is a
 * guess worth making when the data can decide instead.
 *
 * A line is suppressed if and only if SOME alignment explains it as a replay. Once no
 * alignment does, the guard disarms for good — there is no re-anchoring, because a guard
 * that could re-anchor mid-stream is a guard that can delete live output minutes later.
 *
 * Three shapes have to work, and the middle one is what a naive version gets wrong:
 *
 *  - The replay is a SUFFIX of what was backfilled. Start partway in and run to the end.
 *  - The replay is LONGER than what was backfilled, its head older. Those leading lines
 *    are history the reader has not seen — emit them, and do not let them disarm the
 *    guard, because the overlap is still ahead.
 *  - The replay DIVERGES, or runs past the end of the history. Disarm; everything after is
 *    output the reader has not been shown.
 *
 * A run of repeated lines survives, which is the property the whole file exists to protect:
 * three backfilled dots cancel exactly three replayed dots, and a fourth the container
 * really printed is shown.
 */
export function expectReplay(
  emitted: readonly LogLine[],
  budget: number = DEFAULT_REPLAY_BUDGET,
): ReplayGuard {
  let armed = emitted.length > 0;
  /**
   * Where the next replayed line would sit, under each alignment still alive. Null until
   * the replay starts; an alignment that reaches the end of the history is dropped, since
   * there is nothing left for it to explain.
   */
  let cursors: number[] | null = null;
  let scanned = 0;

  /** The positions among `positions` whose line is this one. */
  const hits = (positions: number[], line: LogLine) =>
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- positions index emitted
    positions.filter((at) => sameLine(emitted[at]!, line));

  return (line) => {
    if (!armed) return false;

    // Before the replay has started every position is a candidate; which occurrence a
    // repeated line was is left for the following lines to decide.
    const found = hits(cursors ?? emitted.map((_, index) => index), line);

    if (found.length === 0) {
      /*
       * Nothing explains this line. Before the replay starts that is a live line arriving
       * ahead of the history, and the budget says how many of those to sit through; after
       * it starts, the replay has diverged and the guard is done.
       */
      if (cursors === null) {
        scanned += 1;
        if (scanned >= budget) armed = false;
      } else {
        armed = false;
      }
      return false;
    }

    // An alignment that reaches the end of the history has nothing left to explain.
    cursors = found.map((at) => at + 1).filter((at) => at < emitted.length);
    armed = cursors.length > 0;
    return true;
  };
}
