import { newIncidentId } from "@/lib/incident";
import type { LogEvent } from "@/lib/log/events";
import { log } from "@/lib/logger";
import { RailwayApiError } from "@/lib/railway/errors";
import type { MessageDescriptor, MessageKey } from "@/lib/messages";

/**
 * The one bridge between what actually failed and what we are willing to say.
 *
 * Upstream failure text is the most useful thing available when debugging and the least
 * safe thing to render: Railway's GraphQL errors name internal fields and, on a schema
 * rejection, quote the document we sent; a WebSocket failure carries the resolved
 * address of the upstream host. Both used to reach the browser verbatim.
 *
 * Deleting the detail outright would have cost the debuggability it existed for, so it
 * moves rather than disappears. The full failure goes to the deployment log against a
 * short id; the browser gets a catalog key and that id. A screenshot now points at a log
 * line instead of being the only evidence.
 */
/**
 * Records a failure server-side and returns the descriptor the browser may see.
 *
 * `scope` names the operation rather than the error — "railway.logStream", "action" — and
 * is emitted as the log record's event name, so a subsystem is a query rather than a
 * substring. The failure's own fields (kind, status, operation, code, the refused path,
 * the scope it implies) used to be flattened into a template string here; they now go
 * through the logger's error serializer and arrive as fields under `err`.
 */
export function reportError(
  scope: LogEvent,
  error: unknown,
  fallback: MessageKey,
): MessageDescriptor {
  const incident =
    error instanceof RailwayApiError ? error.incidentId : newIncidentId();

  // `incident` stays top-level rather than under `err`: it is the join key between a
  // screenshot and a log line, and it exists for failures that are not RailwayApiErrors
  // and therefore carry no id of their own.
  log.error(scope, { incident, error });

  return error instanceof RailwayApiError
    ? error.describe()
    : { key: fallback, values: { incident } };
}
