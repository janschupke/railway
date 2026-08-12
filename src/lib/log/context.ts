import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Request-scoped fields that every log record picks up automatically.
 *
 * The alternative was threading a correlation id through `gql()`'s options and therefore
 * through every Railway call, for one field. The call depth here is real — a stream goes
 * route → monitor → api → client — and the deployment monitor outlives the request that
 * created it, so an argument would have to survive a handoff no argument survives.
 */
export type RequestContext = {
  /** 16 hex chars. Minted in the proxy for proxied paths, by the handler otherwise. */
  requestId: string;
  /** The OIDC subject. Never the email, never the display name. */
  subjectId?: string;
  /** The static route pattern, not the concrete path — bounded cardinality. */
  route?: string;
};

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, run: () => T): T {
  return storage.run(context, run);
}

export function requestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Attaches the identity to a scope that was entered before it was known.
 *
 * Mutates the live store rather than re-entering: a handler enters its scope, *then*
 * opens the session, and the lines it logs before that point should still share the id.
 * Nothing else writes to the store, so the mutation has one writer.
 */
export function setSubjectId(subjectId: string): void {
  const current = storage.getStore();
  if (current) current.subjectId = subjectId;
}

/**
 * Sixteen hex chars.
 *
 * Deliberately not `newIncidentId` from lib/incident.ts, despite the identical technique:
 * an incident id is read off a screenshot by a human and is sized to stay greppable, and
 * a request id is only ever machine-read and wants the collision resistance instead.
 * Keeping incident.ts import-free is also what holds errors.ts ↔ report-error.ts acyclic.
 */
export function newRequestId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export const REQUEST_ID_PATTERN = /^[0-9a-f]{16}$/;
