import { RailwayApiError } from "@/lib/railway/errors";

/**
 * Turns a thrown value into fields that are safe to write to a retained log.
 *
 * This is the security control, not a formatting helper, which is why it lives in its own
 * dependency-light module: it has to be testable without constructing a logger, and it
 * must never be the thing someone edits casually while tuning log output.
 *
 * Three rules, each of which has already cost this codebase once:
 *
 * 1. **`cause` is never read, at any depth.** `oauth4webapi` throws
 *    `UnsupportedOperationError("unsupported token_type value", { cause: { body: json } })`
 *    where `json` is the parsed token response — a live `access_token` and `refresh_token`
 *    (oauth4webapi@3.8.6/build/index.js:1276); other branches put the decoded id_token
 *    `claims` there. `RailwayApiError` and `SessionExpiredError` both assign `this.cause`
 *    too, and it is an *enumerable own property*, so anything that stringifies an error
 *    wholesale emits it. See lib/auth/redact.ts, which exists for the same reason.
 * 2. **Keys are never enumerated.** No spread, no `for…in`. Only the fields named below
 *    are read, so a future error class carrying something sensitive cannot opt itself in.
 * 3. **A non-Error object is never stringified.** `String({…})` is `"[object Object]"` on
 *    a good day and a JSON blob on a bad one; neither is worth the risk of finding out
 *    which one a token response is.
 */
export type ErrorFields = {
  type: string;
  message: string;
  stack?: string;
  kind?: string;
  status?: number;
  operation?: string;
  code?: string;
  /** The refused GraphQL field — a dead token and an ungranted scope look alike without it. */
  path?: string;
  missing_scope?: string;
  schema_rejection?: true;
  incident?: string;
};

export function errorFields(error: unknown): ErrorFields {
  if (error instanceof RailwayApiError) {
    /*
     * No stack. Every one of these is constructed by the same mapper in client.ts, so the
     * frames name this app's own plumbing rather than anything that failed — and at ~700
     * bytes a record on the noisiest `warn` path, that is real money for a log Railway
     * retains and bills for. The fields below carry the whole diagnosis instead, which is
     * the point of classifying these errors at all.
     */
    return {
      type: error.name,
      message: error.message,
      kind: error.kind,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.operation ? { operation: error.operation } : {}),
      ...(error.code ? { code: error.code } : {}),
      ...(error.path?.length ? { path: error.path.join(".") } : {}),
      ...(error.missingScope ? { missing_scope: error.missingScope } : {}),
      ...(error.isSchemaRejection() ? { schema_rejection: true as const } : {}),
      incident: error.incidentId,
    };
  }

  if (error instanceof Error) {
    // `stack` begins with `name: message`, so it adds frames and nothing else. It is the
    // one place a file path appears in a record; paths are not secrets.
    return { type: error.name, message: error.message, stack: error.stack };
  }

  if (typeof error === "object" && error !== null) {
    return { type: "unknown", message: "[non-error object]" };
  }

  // A thrown primitive: its own string form is the whole value, so it is safe.
  return { type: "unknown", message: String(error) };
}
