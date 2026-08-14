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
  /**
   * Railway has no deployment-status subscription, so status is polled.
   *
   * Where a poll *starts*, not where it stays: every reported state change resets to this
   * value, so a deployment that is actually moving is watched at this cadence from end to
   * end. One that is not stretches towards MAX_POLL_MS — see POLLS_BEFORE_ESCALATION.
   */
  STATUS_POLL_MS: 2_500,
  /**
   * Status polls at one interval before it doubles, while the reported state does not
   * change.
   *
   * Four keeps full resolution for the first ten seconds, which is the window that
   * matters: a just-created deployment is still resolving there — MISSING_POLLS_BEFORE_STOP
   * spends all three of its polls inside it — and a small image pull can finish inside it.
   * Doubling from the first repeat instead would put a thirty-second deploy at the ceiling
   * after 7.5s, which is a lot of staleness bought for eleven requests.
   *
   * The ladder is 2.5s ×4, 5s ×4, 10s ×4, then MAX_POLL_MS: twelve polls covering the
   * first seventy seconds of any one state, and the ceiling from there.
   */
  POLLS_BEFORE_ESCALATION: 4,
  /**
   * Ceiling on the status poll interval while Railway is answering normally.
   *
   * At a flat 2.5s a fifteen-minute stream was 360 requests, and the four streams
   * MAX_CONCURRENT_PER_USER allows were 1,440 an hour against Hobby's documented 1,000 —
   * the status poll alone over budget, before the watcher's 240 (ADR-10) and every
   * dashboard render. With the ladder above, a stream that never changes state at all
   * costs 12 + (900 − 70) / 15 ≈ 67 requests, so the same four are ~270 an hour.
   *
   * Fifteen seconds rather than more because this is the worst case for how stale the
   * badge can be when a deployment finishes, and it is only ever reached by a deployment
   * that has sat in one state for over a minute — QUEUED → BUILDING → DEPLOYING → SUCCESS
   * resets at every step and never leaves the base rung for long.
   */
  MAX_POLL_MS: 15_000,
  /**
   * Ceiling on the status poll interval after a *failure*, which is a different question
   * and gets a different number.
   *
   * A healthy stream trades staleness for quota, and fifteen seconds is the most staleness
   * a working deployment should carry. A failing one has no fresh status to be stale about,
   * and each of its polls costs up to NETWORK.MAX_ATTEMPTS requests inside the client — so
   * the flat cadence was really up to 1,080 requests per wedged stream. Doubling from the
   * base reaches this ceiling after five failures and 77.5s.
   *
   * Also the clamp on Railway's own Retry-After, which against a 1,000/hour quota is
   * routinely tens of seconds. Not WATCH.MAX_POLL_MS's two minutes, because a log stream
   * lives at most MAX_DURATION_MS: a two-minute backoff is an eighth of its whole life, and
   * a deployment that recovered would show a stale badge until the connection closed.
   */
  MAX_BACKOFF_MS: 60_000,
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
   * socket and a poll for the full duration ceiling.
   *
   * A count rather than a deadline, deliberately: the interval escalates while the state
   * does not change, so eight polls is about half a minute here and the bound holds
   * whatever that ladder is tuned to.
   */
  UNSETTLED_POLLS_BEFORE_STOP: 8,
  /**
   * Deployment events read once when a deployment settles as FAILED.
   *
   * Ten because DeploymentEventStep has ten members: a deployment that walked every step
   * still fits in one page, so the reason — which is on the last step that ran — is never
   * behind a cursor and this never needs to paginate.
   *
   * Read once per failed deployment, from its own document, and never from the status
   * poll. See DEPLOYMENT_EVENTS_QUERY for what putting a withdrawable field in that loop
   * would cost: one extra request per failure is quota this app can afford, and 360 schema
   * rejections per wedged stream is not.
   */
  FAILURE_EVENTS: 10,
  /**
   * Ceiling on the failure text a failed row will render.
   *
   * DeploymentEventPayload.error is an unbounded String from upstream that ends up in one
   * SSE frame and one paragraph. 300 characters is roughly three lines at the row's width
   * — enough for "manifest for redis:nope not found" or a health-check response body,
   * short enough that a stack trace cannot push "Open in Railway" below the fold.
   *
   * Nothing is lost by cutting: Railway's own page holds all of it, and the button to that
   * page is on the same block in every branch.
   */
  FAILURE_REASON_MAX: 300,
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
  /**
   * Floor between two `router.refresh()` calls, across every source in the tab.
   *
   * /dashboard is force-dynamic, so one refresh is two Railway round trips. The watcher
   * and every settling row all want to refresh on the same event, and each used to
   * decide for itself — see hooks/use-throttled-refresh.ts for why the guard has to be
   * shared rather than per-component.
   */
  MIN_REFRESH_GAP_MS: 2_000,
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
  /**
   * How long a settled refresh stays claimable by a caller still holding the token it
   * spent.
   *
   * Railway invalidates a refresh token on first use, so a request that was already in
   * flight with the old cookie when another one won the race arrives at a token that is
   * already dead. Deleting the entry the instant the grant resolved meant only strictly
   * overlapping callers were deduped, and a caller that lost by milliseconds was signed
   * out of a healthy session. Sized by how far a slow request can lag the winner — a
   * cold render plus an upstream round trip, not a minute of it — with room to spare.
   */
  REFRESH_GRACE_SECONDS: 60,
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
  /**
   * Environment variables one spin-up may carry.
   *
   * A long way past every preset in the catalog — the largest declares two — and past the
   * handful a real image documents, while staying a list a person can see on one screen.
   * Not a Railway limit; Railway accepts far more. It is the point past which this editor
   * is the wrong tool and the service's own Variables page on Railway is the right one.
   */
  VARIABLES_MAX: 25,
  /**
   * Variable name length.
   *
   * A legibility bound rather than a platform one: POSIX guarantees nothing here and
   * Linux's own ceiling is the whole environment block rather than any single name. A
   * name longer than this does not fit the editor's key column at any viewport.
   */
  VARIABLE_NAME_MAX: 64,
  /**
   * Variable value length.
   *
   * Sized for what people legitimately paste into a single-line field — a connection
   * string, a JWT, an API key — and not for what does not belong in one: a certificate, a
   * private key, a JSON document. Those need a multi-line editor, which is a different
   * ticket, and a value arriving with a newline in it is refused rather than silently
   * truncated by the browser.
   */
  VARIABLE_VALUE_MAX: 2048,
  /**
   * Characters of names and values in one submission, across every row.
   *
   * The per-row caps multiply — 25 × (64 + 2048) is over fifty thousand characters — so
   * this is the bound that actually holds. Counted in characters rather than bytes on
   * purpose: it is a form limit a person has to be told about, not a transport one, and
   * the transport already has its own (Next's Server Action body limit, 1 MB by default).
   * Deliberately below that, so the ceiling producing a readable sentence is this one.
   */
  VARIABLES_TOTAL_MAX: 16_000,
} as const;

/** Presentation thresholds that are not styling. */
export const UI = {
  /** Distance from the bottom within which the log pane stays auto-scrolled. */
  AUTOSCROLL_THRESHOLD_PX: 24,
  /**
   * Shortest log needle worth highlighting.
   *
   * A bound on the DOM rather than a nicety. A single character matches most of a
   * thousand buffered lines, which is tens of thousands of <mark> elements rebuilt on
   * every keystroke for a result that tells the reader nothing. The scan itself costs
   * microseconds; the elements do not.
   */
  LOG_SEARCH_MIN_CHARS: 2,
  /**
   * Ceiling on the log needle. Longer than LIST.QUERY_MAX, and for a different reason:
   * that one is sized to a container name, this one to a phrase lifted out of a stack
   * trace, which is what people actually paste into a log search.
   */
  LOG_QUERY_MAX: 120,
  /**
   * Severity values the log filter will render chips for.
   *
   * The control is built from whatever the buffer contains, because Railway's `severity`
   * has never been observed carrying a value here. If it turns out to be free-form rather
   * than an enum, a thousand lines could yield hundreds of distinct values and the
   * toolbar would become the page. Above this the control declines to render at all.
   */
  LOG_SEVERITY_MAX: 6,
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
 * It is repeated inside a failed row's panel, and stays there now that the row asks
 * `deploymentEvents` for a reason. That read is best effort by design — the feed can be
 * empty, refused, or withdrawn — and the deployment query still returns a status and
 * nothing else, so "Failed" over a legitimately empty pane remains a state the app can
 * reach. Railway's own page is where the rest of it lives in every one of those branches,
 * which is why this link is unconditional rather than a fallback the reason replaces.
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
