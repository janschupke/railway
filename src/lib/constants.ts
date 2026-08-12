/**
 * Every tuned number in the app, grouped by the concern that owns it.
 *
 * These were previously scattered as inline literals across the client, the stream
 * route, the session layer and three components. Collecting them means a reviewer can
 * see the whole tuning surface at once, and means the same value cannot drift between
 * two files (the log backfill limit had already diverged from its default).
 */

/** Talking to Railway's HTTP API. */
export const NETWORK = {
  /** A human is watching a button spinner, so retries stay short. */
  RETRY_BASE_MS: 400,
  RETRY_FACTOR: 3,
  MAX_ATTEMPTS: 3,
  REQUEST_TIMEOUT_MS: 20_000,
} as const;

/** The SSE stream and its upstream subscription. */
export const STREAM = {
  /** Comment frames stop proxies idling the connection out during a long build. */
  KEEPALIVE_MS: 15_000,
  /** Railway has no deployment-status subscription, so status is polled. */
  STATUS_POLL_MS: 2_500,
  /** Grace period for trailing log frames after a terminal status. */
  DRAIN_MS: 2_000,
  /** Ceiling so a wedged build cannot pin a connection forever. */
  MAX_DURATION_MS: 15 * 60 * 1000,
  /** Lines fetched on attach and on reconnect, so a drop leaves no hole. */
  BACKFILL_LINES: 200,
  /** Bound on the browser-side buffer; a chatty container must not grow the tab. */
  MAX_BUFFERED_LINES: 1000,
} as const;

/** Session cookie and token lifetimes. */
export const SESSION = {
  /** Refresh this far ahead of expiry. Railway access tokens live one hour. */
  REFRESH_SKEW_SECONDS: 300,
  MAX_AGE_SECONDS: 60 * 60 * 24 * 30,
  /** PKCE verifier and state only need to survive the round-trip to Railway. */
  TRANSIENT_MAX_AGE_SECONDS: 60 * 10,
} as const;

/** User input bounds. */
export const LIMITS = {
  /** Slug length after prefixing; Railway service names are not unbounded. */
  SERVICE_SLUG_MAX: 32,
  CONTAINER_NAME_MAX: 40,
  IMAGE_REF_MAX: 255,
} as const;

/** Presentation thresholds that are not styling. */
export const UI = {
  /** Distance from the bottom within which the log pane stays auto-scrolled. */
  AUTOSCROLL_THRESHOLD_PX: 24,
} as const;
