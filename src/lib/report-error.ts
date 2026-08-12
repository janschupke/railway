import { newIncidentId } from "@/lib/incident";
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
function detailOf(error: unknown): string {
  if (error instanceof RailwayApiError) {
    const fields = [
      `kind=${error.kind}`,
      error.status ? `status=${error.status}` : null,
      error.operation ? `op=${error.operation}` : null,
      error.code ? `code=${error.code}` : null,
      // The refused field, which is the difference between a dead token and a scope
      // that was never granted. Without it the log says no more than the browser does.
      error.path?.length ? `path=${error.path.join(".")}` : null,
      error.missingScope ? `needs=${error.missingScope}` : null,
      error.isSchemaRejection() ? "schemaRejection" : null,
    ].filter(Boolean);
    return `${fields.join(" ")} :: ${error.message}`;
  }
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * Records a failure server-side and returns the descriptor the browser may see.
 *
 * `scope` names the operation rather than the error — "railway.logStream", "action" —
 * so the log is greppable by subsystem as well as by id.
 */
export function reportError(
  scope: string,
  error: unknown,
  fallback: MessageKey,
): MessageDescriptor {
  const incident =
    error instanceof RailwayApiError ? error.incidentId : newIncidentId();

  console.error(`[${incident}] ${scope}: ${detailOf(error)}`);

  return error instanceof RailwayApiError
    ? error.describe()
    : { key: fallback, values: { incident } };
}
