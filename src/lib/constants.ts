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
  /**
   * Bound on the SERVER-side buffer, for the same reason one tick earlier.
   *
   * MAX_BUFFERED_LINES above caps the tab, which is no help when the reason the tab is
   * not reading is that its socket has stalled — the frames pile up in the monitor's
   * AsyncQueue on this side instead, and that array had no ceiling at all.
   *
   * Matched to MAX_BUFFERED_LINES deliberately rather than tuned separately: the browser
   * discards past 1000 anyway, so anything buffered above that is memory held for lines
   * no one will ever be shown.
   */
  MAX_QUEUED_EVENTS: 1000,
  /**
   * Concurrent log streams one user may hold.
   *
   * Bounded by the BROWSER, not by this server. Chrome and Firefox allow six connections
   * per origin over HTTP/1.1, and `next start` speaks HTTP/1.1 — so a seventh EventSource
   * does not fail, it queues, with nothing on the wire, nothing in any log, and a pane
   * that sits on "Connecting…". This was 8, which meant the cap that actually applied was
   * the invisible one.
   *
   *   6 − 1 (the project watcher, api/watch) − 1 (reserved for RSC navigation and Server
   *   Action fetches, which share the same pool) = 4.
   *
   * A refused stream now says so — see containers.streamUnavailable — rather than
   * presenting as silence.
   */
  MAX_CONCURRENT_PER_USER: 4,
  /**
   * Status polls tolerated before concluding a deployment does not exist. Railway is
   * eventually consistent, so the first poll after a deploy legitimately returns null;
   * without a ceiling, an id that never resolves kept a poll and an upstream socket
   * alive for the full MAX_DURATION_MS.
   */
  MISSING_POLLS_BEFORE_STOP: 3,
  /**
   * Polls tolerated in a state that is neither terminal nor transitioning before the
   * stream gives up. `unknown` is the only such state, and it means Railway added an
   * enum member this app does not map — which must not pin a connection, an upstream
   * socket and a 2.5s poll for the full duration ceiling.
   */
  UNSETTLED_POLLS_BEFORE_STOP: 8,
} as const;

/**
 * The project watcher.
 *
 * Separate from STREAM because the cost profile is different: one long-lived connection
 * per visible tab, polling a single query, rather than one per expanded row carrying an
 * upstream socket.
 */
export const WATCH = {
  /*
   * The poll interval itself is not here — it is WATCH_POLL_MS in env.ts, because the
   * right value depends on the plan behind the token. One request per tick per *visible*
   * tab: the 15s default is 240/hour against Hobby's 1000, and zero for a tab nobody is
   * looking at, since the client holds no connection while hidden.
   */
  /** Spread, so several tabs opened together do not align on the same second. */
  JITTER: 0.2,
  /** Backoff ceiling after repeated Railway failures. */
  MAX_POLL_MS: 120_000,
  /**
   * Watchers one user may hold. Two, because switching projects re-establishes the
   * watcher while the old one is still closing — the same reason STREAM's cap sits above
   * its own honest working set.
   */
  MAX_PER_USER: 2,
} as const;

/** Session cookie and token lifetimes. */
export const SESSION = {
  /** Refresh this far ahead of expiry. Railway access tokens live one hour. */
  REFRESH_SKEW_SECONDS: 300,
  MAX_AGE_SECONDS: 60 * 60 * 24 * 30,
  /**
   * PKCE verifier and state only need to survive the round-trip to Railway — but that
   * round trip includes picking projects on the consent screen, which routinely takes
   * longer than ten minutes. Expiring underneath the user cost them the whole attempt:
   * `missing_pkce_state`, back to the landing page, and a fresh consent round.
   */
  TRANSIENT_MAX_AGE_SECONDS: 60 * 30,
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

/**
 * The container list's filtering, paging and scroll affordances.
 *
 * All presentation: Railway's project query returns every service in one response and
 * accepts no filter or cursor, so none of these numbers reach the network. They bound
 * what is *rendered*, which is what actually costs — each visible row is a client
 * component that may hold a log stream.
 */
export const LIST = {
  /** Rows per page, and the increment each Load more adds. */
  PAGE_SIZE: 20,
  /**
   * Search settle time.
   *
   * Not merely a URL-write throttle: filtering changes which rows are mounted, and a
   * mounted row opens an EventSource for a transitioning container against
   * STREAM.MAX_CONCURRENT_PER_USER. Undebounced, a typed word would open and tear down
   * streams per keystroke.
   */
  SEARCH_DEBOUNCE_MS: 250,
  /** Ceiling on the search needle; longer than the longest container name plus a tag. */
  QUERY_MAX: 64,
  /** Load the next page before the sentinel reaches the viewport, not as it arrives. */
  SENTINEL_ROOT_MARGIN_PX: 200,
  /** Scroll depth past which returning to the top stops being a flick of the wrist. */
  SCROLL_TOP_AFTER_PX: 640,
} as const;

/**
 * Outbound links. Not the API endpoints — those are configurable per environment in
 * env.ts so the E2E fixture can stand in; these are the human-facing pages, which
 * always point at the real Railway and at this app's own source.
 */
export const LINKS = {
  RAILWAY_DASHBOARD: "https://railway.com/dashboard",
  RAILWAY_HOME: "https://railway.com",
  /** Base for a deep link into one service; see railwayServiceUrl below. */
  RAILWAY_PROJECT: "https://railway.com/project",
  REPOSITORY: "https://github.com/janschupke/railway",
} as const;

/**
 * One service on Railway's own dashboard.
 *
 * Built entirely from ids a container row already holds, so this escape hatch costs no
 * API call — which is the only reason it can sit on every row, as the container name.
 *
 * It is repeated inside a failed row's panel because the app's whole knowledge of a
 * failed deployment is the enum FAILED:
 * the deployment query returns a status and nothing else, a service created from an image
 * performs no build, and a pull that fails may write no deployment logs either. The badge
 * says "Failed" over a legitimately empty pane, and Railway's own page is the only place
 * the reason exists. Pointing at it is more honest than leaving the user to guess.
 *
 * The ids are Railway's rather than the user's, and encoded anyway — a link builder that
 * trusts its inputs is one refactor away from not being able to.
 */
export const railwayServiceUrl = (params: {
  projectId: string;
  serviceId: string;
  environmentId: string;
}): string =>
  `${LINKS.RAILWAY_PROJECT}/${encodeURIComponent(params.projectId)}` +
  `/service/${encodeURIComponent(params.serviceId)}` +
  `?environmentId=${encodeURIComponent(params.environmentId)}`;
