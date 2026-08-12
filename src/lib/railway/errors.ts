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

  constructor(
    message: string,
    options: {
      kind: RailwayErrorKind;
      status?: number;
      operation?: string;
      retryAfterSeconds?: number;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "RailwayApiError";
    this.kind = options.kind;
    this.status = options.status;
    this.operation = options.operation;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.cause = options.cause;
  }

  /** Copy safe to hand to the browser — never includes token or header material. */
  toClientError(): { message: string; kind: RailwayErrorKind } {
    return { message: this.userMessage(), kind: this.kind };
  }

  userMessage(): string {
    switch (this.kind) {
      case "auth":
        return "Railway rejected the request. Your authorization may have been revoked — sign in again.";
      case "rate_limit":
        return this.retryAfterSeconds
          ? `Railway's rate limit was hit. Try again in ${this.retryAfterSeconds}s.`
          : "Railway's rate limit was hit. Try again shortly.";
      case "network":
        return "Could not reach Railway. Check your connection and retry.";
      case "server":
        return "Railway returned a server error. This is usually transient — retry.";
      case "graphql":
        return this.message;
    }
  }
}
