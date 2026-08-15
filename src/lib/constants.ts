/**
 * Every tuned number the application proper runs on, grouped by the concern that owns it.
 *
 * These were previously scattered as inline literals across the client, the stream
 * route, the session layer and three components. Collecting them means a reviewer can
 * see the whole tuning surface at once, and means the same value cannot drift between
 * two files (the log backfill limit had already diverged from its default).
 *
 * Two exclusions, both deliberate, because "every tuned number in the app" was written
 * here when it was true and had stopped being so.
 *
 * `WATCH_POLL_MS` and `METRICS_POLL_MS` live in `src/env.ts`, because the right value for
 * each depends on the rate limit of the plan behind the token. The `WATCH` and `METRICS`
 * groups below say so where a reader would otherwise look for them.
 *
 * `src/features/**` owns its own — `src/features/rail-yard/config.ts` holds roughly ninety
 * of them. That is the right home rather than an oversight: the rail yard is decoration
 * with one consumer and no application data flowing through it, so its timestep and its
 * track geometry are not part of this app's tuning surface and would only make this file
 * harder to read whole. A number that a Railway request, a session or a rendered container
 * depends on belongs here; a number that only moves a pixel belongs there.
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
   * Status is polled rather than subscribed to. See ADR-3 for why.
   *
   * Not because Railway lacks the subscription — it publishes `deployment(id:)` with a
   * non-null `status`, which this comment used to deny. The reason is that subscribing
   * would hold a second upstream socket per open log pane, against
   * MAX_CONCURRENT_PER_USER, to replace a poll that already stretches to nothing while a
   * deployment sits still.
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
  /**
   * Lines fetched on attach and on reconnect, so a drop leaves no hole.
   *
   * Measured against the live API on 2026-08-14 (`pnpm probe:logs`): `limit` selects the
   * most recent N, oldest first, and Railway returns one or two more than asked for — so
   * this is a floor rather than an exact count, and nothing may depend on the length.
   *
   * Staying above the subscription's own default of 100 is load-bearing, see
   * REPLAY_SCAN_LINES.
   */
  BACKFILL_LINES: 200,
  /**
   * How many live lines the replay guard will look through before deciding the
   * subscription is not replaying the backfill after all.
   *
   * One, and the measurement is why. Subscribing to `buildLogs` delivers the most recent
   * 100 lines in a burst before any live output — Railway's documented default `limit` for
   * the subscription, which takes no `startDate` to bound it with. So the replay is always
   * the FIRST thing the socket says, never something that starts three lines in.
   *
   * Because BACKFILL_LINES (200) is larger than that window, the replay is a suffix of what
   * the backfill already showed rather than history reaching further back — measured at
   * 100 of 100 replayed lines suppressed, none of them predating the backfill. Raising this
   * would keep the guard armed while genuinely new output arrives, and a container printing
   * the same line twice would have the second one swallowed.
   */
  REPLAY_SCAN_LINES: 1,
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
   * per origin over HTTP/1.1, and the server this app ships speaks HTTP/1.1 — so a
   * seventh EventSource does not fail, it queues, with nothing on the wire, nothing in any
   * log, and a pane that sits on "Connecting…". This was 8, which meant the cap that
   * actually applied was the invisible one.
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
  /**
   * Where the BROWSER's reconnect backoff starts after the EventSource dies, and its
   * ceiling.
   *
   * The client half of this loop, and it was declared in `use-project-watcher.ts` instead —
   * two module constants sitting a directory away from `MAX_POLL_MS` below, which is the
   * server half of the same loop. They had already diverged: the client ceiling was a
   * minute against the server's two, with nothing saying whether that was reasoned or
   * accidental.
   *
   * It is reasoned, and now it is next to the number it is reasoned against. A browser that
   * has lost the connection is retrying a request that costs this server nothing until it
   * succeeds, so it can afford to come back sooner than the server's own poll ladder backs
   * off. Nothing here is urgent: a watcher that reconnects a minute late costs a stale
   * container list, not a missed action.
   */
  CLIENT_RETRY_BASE_MS: 5_000,
  CLIENT_RETRY_CEILING_MS: 60_000,
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

/**
 * The usage readout.
 *
 * Separate from WATCH because it owns no cadence of its own: metrics are read on the render
 * the watcher already causes, and the only thing that decides how often that happens is
 * METRICS_POLL_MS in env.ts — which is there rather than here for the same reason
 * WATCH_POLL_MS is. What is left over is the shape of the one query, which is what these
 * three numbers are.
 */
export const METRICS = {
  /**
   * How far back the metrics query reaches.
   *
   * Five minutes is a floor and a ceiling at once. Below it, a container that started
   * moments ago may have produced no sample at all and would read as "—" while plainly
   * running. Above it, the newest point is still the newest point — the extra history is
   * response weight for a readout that renders exactly one number per measurement.
   */
  WINDOW_MS: 5 * 60 * 1000,
  /**
   * `sampleRateSeconds`. What actually bounds the response.
   *
   * WINDOW_MS / 60 is five points per service per measurement, plus the one aggregate row
   * Railway adds per measurement and the mapper drops. Four measurements — two usage, two
   * ceilings — so a twenty-service environment is:
   *
   *     4 × (20 services × 5 points + 1 aggregate × 1 point) = 404 points, 84 results
   *
   * Twice what the two usage measurements alone cost, inside the SAME request: `measurements`
   * is a query variable, so the ceilings changed the response weight and left the request
   * count exactly where ADR-10's arithmetic has it.
   *
   * Railway's own default resolution over the same window would be thousands, for data this
   * app throws away on the next line — the app reads the newest point and nothing else. The
   * rest is what a sparkline would need, and a sparkline is a different ticket that would pay
   * for it deliberately.
   */
  SAMPLE_RATE_SECONDS: 60,
  /**
   * `averagingWindowSeconds`, matched to the sample rate rather than tuned separately.
   *
   * Unmatched, the two disagree about what a point means: a one-second average sampled once
   * a minute renders whatever the container happened to be doing in that second, so a burst
   * reads as the steady state and an idle instant hides one. Matched, each point is the mean
   * of the interval it covers, which is what a "current usage" figure should be.
   */
  AVERAGING_WINDOW_SECONDS: 60,
} as const;

/** Session cookie and token lifetimes. */
export const SESSION = {
  /** Refresh this far ahead of expiry. Railway access tokens live one hour. */
  REFRESH_SKEW_SECONDS: 300,
  /**
   * How long to assume an access token lives when Railway's response omits `expires_in`.
   *
   * One hour, which is what Railway issues. Both grant paths need it — the callback and
   * the refresh — and both had it inline as a bare `?? 3600`, in different files, which is
   * exactly the two-file drift this module exists to prevent. The comment above already
   * said "Railway access tokens live one hour" without there being a constant for it.
   *
   * A fallback rather than a tuning knob: if it is ever wrong, the session is refreshed
   * early or late by the difference, and REFRESH_SKEW_SECONDS is the margin that absorbs it.
   */
  DEFAULT_EXPIRES_IN_SECONDS: 3600,
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

/** Double-submit protection for the one action that creates billable infrastructure. */
export const IDEMPOTENCY = {
  /**
   * How long a settled spin-up stays claimable by a submission carrying the same key.
   *
   * The window opens when the create *settles*, so it does not have to cover the time
   * on the wire — a submission that overlaps another shares its entry outright, and that
   * entry is held however long the three Railway mutations take. This covers the other
   * repeat: a person who saw something that looked like a failure and pressed the button
   * again. SESSION.REFRESH_GRACE_SECONDS is a minute because a lagging request is
   * machine-paced; this one is paced by somebody deciding to try again.
   *
   * It is also what bounds the map. Entries are swept lazily on the next call, so what is
   * resident is "spin-ups in the last five minutes on this replica", not "spin-ups ever".
   */
  RETAIN_SECONDS: 300,
} as const;

/** User input bounds. */
export const LIMITS = {
  /** Slug length after prefixing; Railway service names are not unbounded. */
  SERVICE_SLUG_MAX: 32,
  CONTAINER_NAME_MAX: 40,
  IMAGE_REF_MAX: 255,
  /**
   * Project name length.
   *
   * Wider than a container name because a project name is prose people write for
   * themselves — "Client work, 2026" — where a container name is a slug this app derives
   * a service name from. Railway's own limit is not published; this bounds what reaches
   * the mutation and comfortably fits the picker's `w-64` trigger before it truncates.
   */
  PROJECT_NAME_MAX: 64,
  /**
   * Environment name length.
   *
   * Deliberately short. Real environment names are `production`, `staging`, `pr-142` — the
   * value is read in a picker beside the project name and repeated in Railway's own URLs,
   * and nothing legible needs more than this.
   */
  ENVIRONMENT_NAME_MAX: 32,
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
  /**
   * Services one bulk destroy may name.
   *
   * A transport bound rather than a product one. The list's own select-all reaches the
   * matched set, which is however many containers the environment holds, and a request is a
   * repeated form field anyone can post any number of — so without a ceiling one submission
   * is an unbounded number of `serviceDelete` mutations, each one sequential and each one
   * against a quota Railway documents at 1,000 requests an hour on Hobby.
   *
   * Fifty because that is already a batch worth pausing over: fifty sequential deletes plus
   * the reads around them is a visible fraction of an hour's quota, and an environment where
   * a person routinely destroys more than fifty at once is one this app is the wrong tool
   * for. The list says when it has stopped at this number rather than truncating quietly.
   */
  BULK_DESTROY_MAX: 50,
  /**
   * The port a public domain routes to, inside the container.
   *
   * The whole legal range rather than a shorter opinionated one, and that is deliberate:
   * this bounds what can reach `ServiceDomainCreateInput.targetPort`, it does not advise
   * which port an image ought to use. A ceiling at 10000 or a floor above 1024 would refuse
   * real images — rabbitmq's own console is 15672, and plenty of containers legitimately
   * run as root on 80 — while stopping nothing, because Railway is the thing that decides
   * whether the port answers.
   *
   * What it does stop is a value that is not a port at all reaching the mutation, which is
   * the only claim a bound like this can honestly make.
   */
  PORT_MIN: 1,
  PORT_MAX: 65_535,
  /**
   * Replicas one container may be created with.
   *
   * A billing bound rather than a platform one — Railway's own ceiling is plan-gated and
   * this app cannot read the plan. Replicas are the one control here that multiplies a cost
   * the app can never attribute back: the usage readout is a workspace figure, so five
   * copies of a container show up as a bigger number with nothing saying which container
   * made it bigger. Five is the point past which someone is scaling rather than spinning
   * something up, and should be doing it on Railway's own page where the price sits next to
   * the number.
   */
  REPLICAS_MAX: 5,
  /**
   * vCPUs one container may be asked for.
   *
   * Railway publishes a per-service ceiling of 8 vCPU on Hobby and 32 on Pro, and this is
   * the lower of the two on purpose. A value Railway refuses costs a created, un-deployed
   * service the person has to go and destroy; a form error costs a sentence. A Pro user who
   * wants more sizes the service on Railway, and the README says so.
   */
  VCPU_MAX: 8,
  /**
   * Memory in GB one container may be asked for.
   *
   * Hobby's per-service ceiling, by VCPU_MAX's argument. Written as its own number rather
   * than derived from that one, because Railway prices and gates the two separately and a
   * shared constant would imply they move together.
   */
  MEMORY_GB_MAX: 8,
  /**
   * Restart attempts before Railway gives up, when the policy is ON_FAILURE.
   *
   * Railway's own default, which is also what its dashboard offers. A larger number here
   * would be a value only this app can set and only Railway can refuse — and the cost of a
   * refusal is a created, un-deployed service rather than a form error.
   */
  RESTART_RETRIES_MAX: 10,
  /**
   * Start command length.
   *
   * A legibility bound, not a platform one: Linux's own limits are ARG_MAX and
   * MAX_ARG_STRLEN, neither of which an honest command approaches. Sized for a docker CMD
   * and a handful of flags. Deliberately well below VARIABLE_VALUE_MAX — a variable value
   * is an opaque blob somebody pastes, a start command is text they have to read back off a
   * single-line field and check.
   */
  START_COMMAND_MAX: 512,
  /**
   * Region identifier length.
   *
   * The value comes out of Railway's own `regions` list, so this bounds what a hand-crafted
   * request can post rather than what the form can produce. Measured against the longest
   * identifier Railway issues today — `europe-west4-drams3a`, twenty characters — with room
   * for a longer one appearing. Paired with REGION_PATTERN in lib/validation.ts; see
   * SECURITY.md on why membership of the fetched list is not what is checked.
   */
  REGION_MAX: 32,
} as const;

/**
 * Asking a container registry whether an image reference exists.
 *
 * The whole subsystem is affordable because of one measured fact: **a manifest HEAD does
 * not consume Docker Hub's anonymous pull budget, and a GET does.** Measured against
 * `library/redis:7-alpine` — two HEADs left `ratelimit-remaining` at `100;w=3600`, a GET
 * took it to 99, and a HEAD after that left it at 99. The README used to argue that a
 * shared egress IP made this check unaffordable; that argument was about pulls, and this
 * is not one.
 *
 * So these numbers are not protecting the user's quota. They protect the *server's* egress
 * — the undocumented per-IP request rate underneath the published budget, and the token
 * endpoints, which no rate-limit header describes at all. That is also why the answer
 * cache is shared across users rather than per session: every entry is an anonymous answer
 * about a public repository, with nothing per-user in it to leak.
 */
export const REGISTRY = {
  /**
   * The whole probe, token round trip included.
   *
   * Deliberately not NETWORK.REQUEST_TIMEOUT_MS's twenty seconds. Nobody is watching a
   * spinner here — there is no spinner — and an answer that lands after the user has
   * finished typing is one nobody reads. A registry that cannot answer in two seconds is
   * `unknown`, which renders nothing.
   */
  PROBE_TIMEOUT_MS: 2_000,
  /**
   * Concurrent probes one user may have in flight, through acquireStreamSlot's namespaced
   * key.
   *
   * Two, not STREAM.MAX_CONCURRENT_PER_USER's four: this holds no upstream socket and no
   * poll, and with the debounce the honest working set is one. The second covers the
   * keystroke that lands while the first is still resolving.
   *
   * Note what this does and does not bound. It bounds SIMULTANEITY. A scripted client can
   * still issue requests serially as fast as upstream answers them; the cache and the
   * cool-off below are what bound rate.
   */
  MAX_CONCURRENT_PER_USER: 2,
  /**
   * How long a real answer is cached.
   *
   * `available` and `unavailable` are facts about a public registry, so they are cacheable
   * across every user of this instance. Ten minutes is long enough that someone iterating
   * on one reference costs a single request, short enough that a tag pushed during a
   * session is eventually seen.
   */
  ANSWER_TTL_MS: 10 * 60 * 1000,
  /**
   * How long `unknown` is cached, which is a different question.
   *
   * `unknown` is the outage answer, and caching an outage for ten minutes would keep the
   * feature dark long after the registry recovered. Thirty seconds is enough to stop a
   * retry storm and short enough to notice the recovery.
   */
  UNKNOWN_TTL_MS: 30_000,
  /**
   * Ceiling on the answer cache.
   *
   * The key is an attacker-chosen string of up to LIMITS.IMAGE_REF_MAX characters, so
   * without a ceiling this map is an unbounded allocation reachable from a form field.
   * Evicted oldest-inserted-first. Five hundred entries is a few hundred kilobytes; the
   * number exists in order to be a number, not because it was tuned.
   */
  CACHE_MAX_ENTRIES: 500,
  /**
   * How long one registry is left alone after it answers 429.
   *
   * Every reference on that registry short-circuits to `unknown` with no request at all.
   * Insurance rather than the primary defence, now that HEAD is known to be free of the
   * pull budget — it exists because the token endpoints are covered by no published limit,
   * and because the failure this ticket must not create is a rate-limited server making
   * the problem worse.
   */
  COOLOFF_MS: 5 * 60 * 1000,
  /**
   * Settle time before the field is checked.
   *
   * Twice LIST.SEARCH_DEBOUNCE_MS, and for the opposite reason. That one settles a local
   * filter and can afford to feel instant; this one leaves the machine, so firing early
   * costs a request rather than a render.
   */
  DEBOUNCE_MS: 500,
} as const;

/**
 * The list of places a container can be created in, and the memo that pays for it.
 *
 * The read itself is one Railway round trip, and the reason it needs a memo at all is that
 * nothing else on the dashboard shares it. `managedNames` costs nothing because it goes
 * through `loadContainers`, which the page already pays for; this has no such carrier, and
 * `/dashboard` is `force-dynamic` — so uncached it would be a request per render, per
 * `router.refresh()`, per watcher tick, against a quota Railway documents at 1,000 an hour
 * on Hobby, for a list of datacentres that changes about twice a year.
 */
export const REGIONS = {
  /**
   * How long a fetched list is kept.
   *
   * REGISTRY.ANSWER_TTL_MS's number and REGISTRY.ANSWER_TTL_MS's argument: long enough that
   * a session costs one request, short enough that a region added or retired during a long
   * session is eventually seen. Nothing here is urgent — a region appearing ten minutes
   * late costs a choice nobody was waiting for.
   */
  TTL_MS: 10 * 60 * 1000,
  /**
   * Ceiling on the memo.
   *
   * Smaller than REGISTRY.CACHE_MAX_ENTRIES because the key is bounded where that one's is
   * not: this is keyed by user id and project id, both of which are ids Railway issued, so
   * the working set is people times their projects rather than anything a form field can
   * enumerate. Evicted oldest-written-first.
   */
  CACHE_MAX_ENTRIES: 200,
} as const;

/*
 * The theme's storage key is NOT here, and that is a bundle decision rather than an
 * oversight. It lives in lib/theme.ts because `ThemeToggle` needs it and sits in the root
 * layout, so an import of this module from there put all of the above into the shared
 * client graph of every route — measured at +1.5 kB gzip on / and /_not-found, and
 * /dashboard 0.1 kB over its budget. Same reason IMAGE_PATTERN lives in
 * lib/registry/reference.ts rather than in lib/validation.ts.
 */

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
  /**
   * How long an icon button shows a tick after the thing it did succeeded.
   *
   * Copy and download are the two controls in this app that answer instantly and leave
   * nothing on screen to show for it — the toast says so, but a toast is what a
   * screen-reader user gets, and a sighted user clicking Copy had no way to tell a
   * successful write from a dead button.
   *
   * Long enough to be seen after the eye returns from wherever the click sent it, short
   * enough that the control is back to its resting state before anyone would press it
   * again. Below roughly a second this reads as a flicker.
   */
  ACTION_FEEDBACK_MS: 1_500,
  /**
   * Backstop for a CSS transition whose `transitionend` never arrives.
   *
   * Toggling a disclosure faster than it animates means the event can be missed, which
   * would leave a zero-height panel mounted — invisible, and still in the tab order.
   *
   * **Twice `--duration-base`**, which is 200ms in `tokens.css`. That relationship is the
   * whole value of the number and it was previously an unexplained `400` inline in
   * `container-row.tsx`: raise the token past 400ms and the backstop starts firing *during*
   * the animation, unmounting a panel that is still opening — which is the class of bug the
   * `intent` ref beside it was added to fix. If the token moves, this moves with it.
   */
  TRANSITION_BACKSTOP_MS: 400,
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
  /**
   * Deployments offered in an expanded row's history, newest first.
   *
   * A bound on the panel rather than on Railway: a service redeployed all week has a history
   * this app has no paging control for, and a list longer than the log pane it sits above
   * turns the row into the page. Ten covers "the one before the one that broke it", which is
   * what a rollback is actually reaching for, and every entry past that is better answered by
   * Railway's own deployment list — which the row already links to.
   *
   * It is also the read's cost. One request per expanded managed row, so the figure is what
   * a panel costs against the rate limit that shapes every read here.
   */
  DEPLOYMENT_HISTORY: 10,
} as const;

/**
 * Outbound links. Not the API endpoints — those are configurable per environment in
 * env.ts so the E2E fixture can stand in; these are the human-facing pages, which
 * always point at the real Railway and at this app's own source.
 */
export const LINKS = {
  RAILWAY_DASHBOARD: "https://railway.com/dashboard",
  /**
   * Railway's account settings — where this app's authorization is removed.
   *
   * The settings root, not a deep link to an authorized-apps view. Railway serves that
   * page only behind its own login, so the exact path cannot be verified from here, and
   * a guessed one that 404s is worse than a click of navigation. The sign-out notice
   * says "account settings" for the same reason.
   */
  RAILWAY_ACCOUNT: "https://railway.com/account",
  RAILWAY_HOME: "https://railway.com",
  /**
   * Where the spend figure actually lives.
   *
   * Reached from the dashboard whenever this app cannot show a number itself — a personal
   * project with no workspace, or a token whose scope does not reach `customer`. Not a
   * deep link to a specific workspace: the id is not always known on those branches, and a
   * link that 404s is worse than one that lands a click away.
   */
  RAILWAY_BILLING: "https://railway.com/workspace/usage",
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
