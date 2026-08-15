import { newIncidentId } from "@/lib/incident";
import type { MessageDescriptor } from "@/lib/messages";

export type RailwayErrorKind =
  | "auth" // 401/403, or a GraphQL-layer refusal — token rejected or scope insufficient
  | "rate_limit" // 429 — retries exhausted
  | "graphql" // HTTP 200 with an errors[] payload
  | "network" // transport failure or timeout
  | "server"; // 5xx after retries

/**
 * The consent scope a refused field would have needed.
 *
 * Railway's scopes are granted per resource family, and its refusal says only "Not
 * Authorized" — the path is the only thing distinguishing "you did not grant workspace
 * access" from "your token is dead". Naming the scope is what makes re-authorizing a
 * fix rather than a guess, which is the loop this app kept sending people round.
 */
function scopeForPath(path?: Array<string | number>): string | undefined {
  if (!path?.length) return undefined;
  const fields = path.filter((s): s is string => typeof s === "string");
  if (fields.includes("workspaces") || fields.includes("workspace")) {
    return "workspace:viewer";
  }
  if (fields.some((f) => f === "project" || f === "projects" || f === "service")) {
    return "project:admin";
  }
  return undefined;
}

/**
 * One entry of a GraphQL `errors[]` array.
 *
 * `path` is modelled rather than ignored because it is the only thing that says *which*
 * field Railway refused, and that is what turns "Railway rejected the operation" into a
 * sentence naming the permission that is missing — see `scopeForPath` above.
 */
export type GraphQLErrorEntry = {
  message: string;
  path?: Array<string | number>;
  extensions?: Record<string, unknown> & { code?: string };
};

/**
 * Railway's authorization refusals, which do not use the codes the spec suggests.
 *
 * Verified against the live API: an unauthorized field comes back as HTTP 200 with
 * `{"message":"Not Authorized","extensions":{"code":"INTERNAL_SERVER_ERROR"}}` — never
 * UNAUTHENTICATED or FORBIDDEN. Matching only on those two codes is what classified
 * every permission problem as a generic operation failure, which then offered a Retry
 * that could not possibly work and withheld the re-authorize that would have.
 */
const AUTH_MESSAGE =
  /\b(not\s+authorized|unauthorized|unauthenticated|forbidden|access denied)\b|\b(invalid|expired|revoked)\s+(access\s+)?token\b/i;

/**
 * Whether one `errors[]` entry is Railway refusing a permission.
 *
 * Here rather than in `client.ts` because it is a statement about how Railway signals
 * authorization, not about how a request is sent — the same knowledge `credentialRejected`
 * and `missingScope` below are built on, and it read strangely for the class that acts on
 * the classification to live two files from the rule producing it.
 */
export function isAuthEntry(entry: GraphQLErrorEntry): boolean {
  const code = entry.extensions?.code;
  if (code === "UNAUTHENTICATED" || code === "FORBIDDEN") return true;
  // A validation failure can mention "field" wording that trips nothing here; the code
  // is checked first so a genuine schema rejection is never mistaken for a permission.
  if (code === "GRAPHQL_VALIDATION_FAILED") return false;
  return AUTH_MESSAGE.test(entry.message);
}

export class RailwayApiError extends Error {
  readonly kind: RailwayErrorKind;
  readonly status?: number;
  readonly operation?: string;
  readonly retryAfterSeconds?: number;
  /** `errors[].extensions.code` verbatim, when Railway sent one. */
  readonly code?: string;
  /** `errors[].path` verbatim — which field was refused. */
  readonly path?: Array<string | number>;
  /**
   * Ties the sentence the user sees to the log line holding Railway's own text. Minted
   * in the constructor so the id is the same one `reportError` logs, however many
   * layers later `describe()` is called.
   */
  readonly incidentId: string = newIncidentId();

  constructor(
    message: string,
    options: {
      kind: RailwayErrorKind;
      status?: number;
      operation?: string;
      retryAfterSeconds?: number;
      code?: string;
      path?: Array<string | number>;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "RailwayApiError";
    this.kind = options.kind;
    this.status = options.status;
    this.operation = options.operation;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.code = options.code;
    this.path = options.path;
    this.cause = options.cause;
  }

  /** The scope this failure implies is missing, if it implies one. */
  get missingScope(): string | undefined {
    return this.kind === "auth" ? scopeForPath(this.path) : undefined;
  }

  /**
   * True when Railway rejected the credential itself rather than what it may reach.
   *
   * The two need opposite advice — a dead token is fixed by signing in, a live token
   * that does not cover a resource is fixed by approving that resource at consent — and
   * only an HTTP 401/403 or a spec-conformant UNAUTHENTICATED says which one this is.
   * Railway's own `Not Authorized` says neither, so it is read as the narrower case.
   */
  credentialRejected(): boolean {
    return (
      this.status === 401 || this.status === 403 || this.code === "UNAUTHENTICATED"
    );
  }

  /**
   * True when Railway refused the *document* rather than the request: an unknown field
   * or a failed validation. Distinct from a runtime GraphQL error, because it means the
   * schema is not what this code was written against, and the answer is to send a
   * different query rather than to retry or to re-authorize.
   */
  isSchemaRejection(): boolean {
    if (this.kind !== "graphql") return false;
    if (this.code === "GRAPHQL_VALIDATION_FAILED") return true;
    // Railway does not always set a code, and the wording is the only other signal.
    return /cannot query field|unknown (field|argument|type)|did you mean/i.test(
      this.message,
    );
  }

  /**
   * Which message to show, not the message itself — this class has no translator and
   * is constructed deep in the network layer, well outside any request scope.
   */
  describe(): MessageDescriptor {
    const incident = this.incidentId;

    switch (this.kind) {
      case "auth":
        /*
         * Three different problems wearing one kind, and they need three different
         * actions. A named missing scope means authorize again and approve it; an HTTP
         * 401 means the whole authorization is gone; a GraphQL-layer refusal means the
         * token is live but does not cover this. Collapsing them into one sentence is
         * how "re-authorize" became the button that never worked.
         */
        if (this.credentialRejected()) {
          return { key: "errors.api.auth", values: { incident } };
        }
        if (this.missingScope) {
          return {
            key: "errors.api.missingScope",
            values: { scope: this.missingScope, incident },
          };
        }
        return { key: "errors.api.notAuthorized", values: { incident } };
      case "rate_limit":
        return this.retryAfterSeconds
          ? {
              key: "errors.api.rateLimitRetry",
              values: { seconds: this.retryAfterSeconds, incident },
            }
          : { key: "errors.api.rateLimit", values: { incident } };
      case "network":
        return { key: "errors.api.network", values: { incident } };
      case "server":
        return { key: "errors.api.server", values: { incident } };
      case "graphql":
        /*
         * Railway's own GraphQL text used to be interpolated straight into this
         * sentence. It names internal fields, and on a schema rejection it quotes the
         * document we sent — neither belongs in a browser. reportError has already
         * written it to the log against this id, so the reference is the detail.
         *
         * isSchemaRejection picks the wording rather than only tagging the log: "the
         * app asked for something the API does not offer" is a different problem from
         * "Railway refused the operation", and the user can tell them apart.
         */
        return this.isSchemaRejection()
          ? { key: "errors.api.graphqlSchema", values: { incident } }
          : { key: "errors.api.graphqlUnexpected", values: { incident } };
    }
  }
}

/** One `errors[]` entry, classified and carried with everything needed to explain it. */
export function toApiError(
  entry: GraphQLErrorEntry,
  operationName: string,
  status: number,
): RailwayApiError {
  const code = entry.extensions?.code;
  const auth = isAuthEntry(entry);
  return new RailwayApiError(entry.message || "Railway rejected the operation", {
    kind: auth ? "auth" : "graphql",
    status,
    operation: operationName,
    ...(code ? { code } : {}),
    ...(entry.path ? { path: entry.path } : {}),
  });
}
