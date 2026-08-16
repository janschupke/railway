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

/**
 * The subset of catalog keys reachable from non-rendering code.
 *
 * An array rather than a bare union, with the union derived from it. i18n.md calls this
 * a two-edit rule — a new key means a member here AND an entry in messages/en.json — and
 * a union is a type, so nothing at runtime could compare the two halves. As a value it
 * can be, and messages.test.ts does: every member resolves in the catalog, and every
 * `errors.*` leaf the catalog holds is reachable from here.
 */
export const MESSAGE_KEYS = [
  "errors.generic",
  "errors.sessionExpired",
  "errors.projectsFailed",
  "errors.containersFailed",
  "errors.logBackfillFailed",
  "errors.deploymentNotFound",
  "errors.streamInterrupted",
  "errors.streamLimit",
  "errors.logsTruncated",
  "errors.api.auth",
  "errors.api.notAuthorized",
  "errors.api.missingScope",
  "errors.api.planLimit",
  "errors.api.rateLimit",
  "errors.api.rateLimitRetry",
  "errors.api.network",
  "errors.api.server",
  "errors.api.graphqlUnexpected",
  "errors.api.graphqlSchema",
] as const;

export type MessageKey = (typeof MESSAGE_KEYS)[number];

/** Narrow shape of next-intl's translator, so callers can pass `t` directly. */
export type Translate = (
  key: MessageKey,
  values?: Record<string, string | number>,
) => string;
