import "server-only";

import type { RailwaySession } from "@/lib/auth/session";
import { STREAM } from "@/lib/constants";
import { requestContext, runWithRequestContext } from "@/lib/log/context";
import { log, type LogEvent, type LogFields } from "@/lib/logger";

/** What the SSE transport reports on teardown. Mirrors sse.ts's own shape. */
type SseCloseInfo = { reason: string; durationMs: number };

/**
 * Shared pieces of the two SSE route handlers.
 *
 * Deliberately NOT a whole prelude. Both routes run the same *sequence* — validate the
 * id, require a session, resolve a translator, take a slot — but every step answers
 * differently: one refuses with 400 and a length, the other with 400 and nothing; one
 * refuses a full slot budget with a 200 carrying a sentence, the other with a bare 429;
 * the event names differ because bounded, stable `msg` values are a rule. A helper
 * covering that would take a callback per branch and be longer than what it replaced.
 *
 * What is genuinely identical is the pair below, and both are parts with a defect history:
 * teardown, where a slot that is not released strands a log pane until the process
 * restarts, and the duration ceiling, where a stream outliving its credential streams
 * nothing at all for as long as it holds the connection.
 */

/**
 * How long this stream may run: the transport's ceiling, or what is left of the access
 * token, whichever comes first.
 *
 * Both routes capture `session.accessToken` once, at open, and nothing refreshes it after
 * that — the proxy renews on navigations, and a held response is not one. So the stream's
 * own lifetime is the only thing standing between a token expiring and a connection that
 * keeps polling Railway with a credential it has already rejected. STREAM.MAX_DURATION_MS
 * alone does not do that job: `requireSession` renews only inside
 * SESSION.REFRESH_SKEW_SECONDS, which is a third of the ceiling, so a stream opened with
 * five minutes and one second of token life ran ten more on a dead one.
 *
 * Closing early is not a loss. It is the same teardown the ceiling already performs, and
 * EventSource answers it by redialling — which arrives as a fresh request, through
 * `requireSession`, holding a fresh token. The alternative reads to the user as a build
 * whose log pane stops.
 *
 * Clamped rather than asserted against the skew, because an assertion couples two
 * constants in unrelated blocks and holds only until someone edits either one. This holds
 * whatever they become.
 *
 * `expiresAt` is epoch SECONDS — see RailwaySession. No floor at zero: on this path the
 * result cannot be non-positive, since requireSession refreshes below the skew or throws,
 * making SESSION.REFRESH_SKEW_SECONDS the smallest value it can return. A negative delay
 * would in any case reach setTimeout as an immediate one, which is a redial rather than a
 * hang.
 */
export function streamDurationMs(session: Pick<RailwaySession, "expiresAt">): number {
  return Math.min(STREAM.MAX_DURATION_MS, session.expiresAt * 1000 - Date.now());
}

/**
 * Runs a stream's close bookkeeping: release the slot, then record it in the scope the
 * request opened in.
 *
 * The scope has to be captured and re-entered, and that is not tidiness. Teardown does
 * not always run where the handler ran: a client hangup arrives through an AbortSignal
 * listener and a runtime cancellation through ReadableStream.cancel, and neither is an
 * async resource created inside the handler — so the close line came out with no
 * request_id and could not be joined to the open line above it, which is the one join
 * anybody actually wants from a stream.
 *
 * Release happens before the log, and unconditionally: a logger that throws must not
 * cost the user a slot.
 */
export function streamCloser(
  event: LogEvent,
  release: () => void,
  fields: (info: SseCloseInfo) => LogFields<Record<string, string | number>>,
): (info: SseCloseInfo) => void {
  /*
   * Captured HERE, when the route builds the callback, and not inside it.
   *
   * This is the whole reason the helper is a factory rather than a function the callback
   * calls. Teardown does not always run where the handler ran — a client hangup arrives
   * through an AbortSignal listener and a runtime cancellation through
   * ReadableStream.cancel, neither of which is an async resource created by the handler
   * — so `requestContext()` read at close time returns nothing at all.
   *
   * A first attempt at this extraction did read it at close time. Every close line lost
   * its request_id, subject_id and route, which is precisely the join the line exists
   * for, and the unit tests could not see it: they assert the fields the caller passes,
   * and the scope is not one of them. The e2e log output is what showed it.
   */
  const scope = requestContext();

  return (info) => {
    try {
      release();
    } finally {
      const record = () => log.info(event, fields(info));
      if (scope) runWithRequestContext(scope, record);
      else record();
    }
  };
}
