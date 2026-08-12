import { newIncidentId } from "@/lib/incident";
import type { MessageDescriptor } from "@/lib/messages";

export type RailwayErrorKind =
  | "auth" // 401/403 — token rejected or scope insufficient
  | "rate_limit" // 429 — retries exhausted
  | "graphql" // HTTP 200 with an errors[] payload
  | "network" // transport failure or timeout
  | "server"; // 5xx after retries

export class RailwayApiError extends Error {
  readonly kind: RailwayErrorKind;
  readonly status?: number;
  readonly operation?: string;
  readonly retryAfterSeconds?: number;
  /** `errors[].extensions.code` verbatim, when Railway sent one. */
  readonly code?: string;
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
    this.cause = options.cause;
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
    switch (this.kind) {
      case "auth":
        return { key: "errors.api.auth" };
      case "rate_limit":
        return this.retryAfterSeconds
          ? {
              key: "errors.api.rateLimitRetry",
              values: { seconds: this.retryAfterSeconds },
            }
          : { key: "errors.api.rateLimit" };
      case "network":
        return { key: "errors.api.network" };
      case "server":
        return { key: "errors.api.server" };
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
          ? { key: "errors.api.graphqlSchema", values: { incident: this.incidentId } }
          : { key: "errors.api.graphqlRef", values: { incident: this.incidentId } };
    }
  }
}
