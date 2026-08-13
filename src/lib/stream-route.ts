import "server-only";

import { requestContext, runWithRequestContext } from "@/lib/log/context";
import { log } from "@/lib/logger";
import type { LogFields } from "@/lib/logger";

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
 * What is genuinely identical is teardown, and teardown is the part with a defect
 * history — a slot that is not released strands a log pane until the process restarts.
 */

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
export function closeStream(
  event: string,
  release: () => void,
  fields: LogFields<Record<string, string | number | undefined>>,
): void {
  const scope = requestContext();
  try {
    release();
  } finally {
    const record = () => log.info(event, fields);
    if (scope) runWithRequestContext(scope, record);
    else record();
  }
}
