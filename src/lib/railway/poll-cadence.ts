/**
 * How often the deployment monitor asks Railway for a status, and how far it backs off
 * when asking fails.
 *
 * Two pure functions that were two closures inside a 505-line generator, sharing that
 * generator's mutable `interval` and `sameStatePolls`. Nothing about either is stateful —
 * both are arithmetic over a number the caller already has — but reaching them meant
 * opening a stream, driving a fake Railway through several polls and inferring the cadence
 * from when the mock was next called. The ladder and the ceiling are now assertable
 * directly, which is what they were missing.
 *
 * The counters stay in the generator, because when to reset them is a statement about the
 * deployment's progress rather than about the cadence.
 */

import { STREAM } from "@/lib/constants";
import { RailwayApiError } from "./errors";

/**
 * The base cadence, doubled once per escalation rung the deployment has sat still for.
 *
 * Derived from the counter rather than doubled in place, so recovering from a failure
 * backoff lands on the rung this deployment's own progress had earned rather than on
 * whatever the last error left behind.
 *
 * A deployment that is genuinely moving resets the counter at every transition and keeps the
 * base cadence from end to end; one that sits in BUILDING for four minutes does not need
 * asking twenty-four times a minute, because its output is arriving over the log
 * subscription anyway and the poll is only there to notice the state change at the end of it.
 */
export function healthyInterval(sameStatePolls: number): number {
  return Math.min(
    STREAM.STATUS_POLL_MS *
      2 ** Math.floor(sameStatePolls / STREAM.POLLS_BEFORE_ESCALATION),
    STREAM.MAX_POLL_MS,
  );
}

/**
 * How long to wait after a failed poll.
 *
 * The same doubling the project watcher uses (api/watch/[projectId]/route.ts), kept separate
 * rather than shared: the two loops have different ceilings and different reset conditions,
 * and what they have in common is three lines of arithmetic.
 *
 * A 429 carries the only informed number in this system. The client has already waited
 * Railway's Retry-After out once per attempt and given up, so polling again before that
 * window closes spends another NETWORK.MAX_ATTEMPTS requests to be told the same thing.
 * Clamped anyway — a Retry-After is a hint from a system under load, not a mandate to hold a
 * stream open doing nothing.
 */
export function backoffFor(error: unknown, interval: number): number {
  const retryAfterMs =
    error instanceof RailwayApiError && error.kind === "rate_limit"
      ? (error.retryAfterSeconds ?? 0) * 1000
      : 0;
  return Math.min(Math.max(interval * 2, retryAfterMs), STREAM.MAX_BACKOFF_MS);
}
