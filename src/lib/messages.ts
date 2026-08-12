/**
 * Message descriptors for code that cannot translate itself.
 *
 * Error classes and the log monitor run far from any request scope, and next-intl's
 * translator is async — so they describe *which* message applies and let the layer that
 * renders resolve it. That also keeps a Railway failure one catalog key rather than a
 * sentence frozen inside a `throw`.
 */
export type MessageDescriptor = {
  key: MessageKey;
  values?: Record<string, string | number>;
};

/** The subset of catalog keys reachable from non-rendering code. */
export type MessageKey =
  | "errors.generic"
  | "errors.sessionExpired"
  | "errors.projectsFailed"
  | "errors.containersFailed"
  | "errors.logBackfillFailed"
  | "errors.deploymentNotFound"
  | "errors.streamInterrupted"
  | "errors.api.auth"
  | "errors.api.notAuthorized"
  | "errors.api.missingScope"
  | "errors.api.rateLimit"
  | "errors.api.rateLimitRetry"
  | "errors.api.network"
  | "errors.api.server"
  | "errors.api.graphqlUnexpected"
  | "errors.api.graphqlSchema";

/** Narrow shape of next-intl's translator, so callers can pass `t` directly. */
export type Translate = (
  key: MessageKey,
  values?: Record<string, string | number>,
) => string;
