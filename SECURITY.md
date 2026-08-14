# Security

A review of this app against the OWASP Top 10, and what came of it. Findings are
recorded with the file they were found in and the file that fixes them, so this is a
record rather than a claim.

## Threat model

The app is **multi-tenant and public**. Any visitor signs in with their own Railway
account and the app then acts on that account, so the credential it holds is delegated
authority over someone else's infrastructure — and the app both creates and destroys
billable resources.

Two consequences shape everything below:

- **The blast radius of a session leak is another person's Railway account**, not a row
  in a database this app owns.
- **Railway is the authorization boundary for resources, not this app.** Every upstream
  call carries the requester's own OAuth token, so this app cannot grant access the user
  does not already have. What it can do — and does — is refuse to _use_ that access for
  things it did not create.

Out of scope: isolation between Railway tenants, and anything Railway's own
authorization is responsible for. In scope: everything between the browser and that
upstream call.

### Input surfaces

Seven things cross from a browser into a Railway mutation. None is trusted; each is
bounded.

| Input                 | Bound                                                                                                                                                                                     | Where                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Image reference       | `IMAGE_PATTERN`, 255 characters                                                                                                                                                           | `src/lib/registry/reference.ts`, `src/lib/validation.ts` |
| Container name        | 40 characters, and prefixed before it is sent — on a rename as well as on create                                                                                                          | `src/lib/validation.ts`, `src/lib/railway/managed.ts`    |
| Environment variables | POSIX name charset, 64 / 2048 characters, 25 rows, 16 000 characters in total, no duplicates, no line breaks, no `RAILWAY_` prefix                                                        | `src/lib/validation.ts`                                  |
| Project name          | 64 characters, trimmed; not prefixed and not slugged                                                                                                                                      | `src/lib/validation.ts`                                  |
| Environment name      | 32 characters, trimmed; not prefixed and not slugged                                                                                                                                      | `src/lib/validation.ts`                                  |
| Public port           | decimal digits only, 1–65 535; blank means no domain is minted at all                                                                                                                     | `src/lib/validation.ts`                                  |
| Resource controls     | region `[a-z0-9-]`, 32 characters; 1–5 replicas; over 0 and up to 8 vCPU; over 0 and up to 8 GB; one of three restart policies; 0–10 retries; 512 characters of single-line start command | `src/lib/validation.ts`                                  |

The port is the newest of these and the narrowest. It reaches exactly one place —
`ServiceDomainCreateInput.targetPort` — on a service the requester's own grant already
covers, and it can do nothing but decide which port inside that container a Railway
hostname routes to. It is refused unless it is plainly decimal, which is stricter than
either obvious coercion: `parseInt` reads `80abc` as 80 and `Number` reads `0x50` as 80,
and both turn a typo into a working port aimed somewhere nobody chose.

**The row's own domain control takes no port from the browser at all.** It posts the same
three ids every lifecycle action posts, and derives the port from `Preset.httpPort` keyed on
the image Railway itself reported for that service — the same rule credential generation
follows, where the catalog grants and the request does not ask. So the one surface that can
aim a domain at an arbitrary port is the create form, where the container being aimed at is
the one being created.

**The region is bounded by charset and length, not by membership of the list the form
offered.** Checking it against Railway's own `regions` answer would mean a second Railway
read inside the Server Action to refuse a value no browser can produce — the options are a
closed `<select>` this app rendered. What a bound here has to stop is a hand-crafted request
putting arbitrary text into a GraphQL variable, and a charset plus a ceiling stops exactly
that. The value becomes one string in one mutation input; it is never a host, a path, a
filename or a command on this server.

**The start command is a command line, and it runs inside the user's own container on the
user's own Railway account.** Nothing on this server interprets it — it is a string in a
mutation input carried by the requester's own token, into a service they asked this app to
create in a project their grant already reaches. That is the same blast-radius argument the
environment-variables row rests on, and it is worth stating rather than leaving to be
inferred, because "a form field that becomes a shell command" reads alarming until the two
accounts involved are the same one. What is bounded is shape: 512 characters, and no line
breaks, for the reason `VARIABLE_VALUE_PATTERN` exists.

Both are recorded the way their cardinality allows. `container.created` and
`railway.settings_failed` carry the region, the replica count, the size and the policy —
all closed or tightly bounded — and `start_command_length` rather than the command, which
is the same split that names preset variables and counts the user's.

An eighth input crosses from the browser and reaches no mutation at all: the spin-up form's
idempotency key, bounded to `[A-Za-z0-9_-]{16,64}` in `src/lib/validation.ts`. Both ends of
that are deliberate. The floor is unguessability — a guessed key is answered with somebody
else's result instead of the container they asked for — and the ceiling is memory, since
the value becomes half of a key in a map that lives as long as the process. The charset is
the one every Railway identifier here uses, which keeps it greppable in a log line.

**A ninth reaches no Railway mutation either, and is the first that reaches anything
outside this app at all**: `?ref=` on `/api/image-check`, the reference the spin-up form
asks a registry about. It is bounded five ways before a byte leaves — a session is
required, `IMAGE_PATTERN` and 255 characters apply as they do on submit, the host must
resolve to one of three allowlisted registries, the user holds at most two probes at once,
and a shared answer cache with a per-registry cool-off bounds the rate. See the outbound
hosts section below for why the allowlist is the control that matters.

**A tenth is the first that reads a secret rather than writing one**: the three ids on
`/api/service-variables`, which the edit dialog sends to find out which variables a service
already has. All three are held to `RAILWAY_ID_PATTERN` before the session is read, and none
of them is logged at any level.

The property that matters here is on the way _out_, not the way in. Railway answers that
query with a name-to-value map, values included; `readServiceVariableNames` reduces it to
names inside `src/lib/railway/api.ts`, so no caller — route handler, Server Action or
component — is holding a value it could return. **A stored variable value reaches no browser
on any path**, which is what lets the edit form show an existing variable as a name with an
empty cell, and what keeps the e2e assertion that a minted credential never appears in page
content true after this feature as it was before it.

**An eleventh reaches no Railway call at all and decides what this app says about itself**: the
`Host` / `X-Forwarded-Host` / `X-Forwarded-Proto` headers, from which `src/lib/origin.ts`
derives the origin this request is served at. It is bounded three ways before anything reads
it — the parse must round-trip to exactly the host it was given, with no path, credentials
or query attached; the resulting origin must be https unless the host is loopback; and
`APP_ORIGINS`, when set, must name it. Anything refused falls back to `APP_URL`, or is
answered 400 when nothing declares one. The accepted-risks section states why the default is
to believe an otherwise-valid host.

Two lesser consequences of the same read, both deliberate. Shared environment variables are
filtered out, because a service cannot delete one and offering the row would promise
otherwise. And ownership is _not_ re-derived on this route, unlike every mutation: the
`MANAGED_PREFIX` check exists to stop this app changing infrastructure it did not create, it
is not an access-control layer, and it could not be one — the request carries the visitor's
own Railway token, which already reads those variables in Railway's own dashboard.

### Outbound hosts

Until the image existence check, every outbound request went to Railway. There are now
four more, and all four are compile-time constants in `src/lib/registry/registries.ts`:

| Host                   | What is sent                                            |
| ---------------------- | ------------------------------------------------------- |
| `auth.docker.io`       | An anonymous pull-token request, scoped to a repository |
| `registry-1.docker.io` | A manifest `HEAD`                                       |
| `ghcr.io`              | Both, on the same host                                  |
| `quay.io`              | Both, on the same host                                  |

The claim this rests on is absolute rather than conditional: **no host, port or scheme in
that subsystem is derived from user input, or from a registry response.** User input only
ever becomes a path segment and a query value against one of those four constants.

Both halves of that matter, and the second is easy to lose. `IMAGE_PATTERN` admits a bare
host as the first component, and Docker's own rules make a first component containing a dot
a registry — so `169.254.169.254/foo/bar` is a _well-formed reference naming a registry_,
which is exactly why checking existence was refused for so long. `parseImageReference`
reports that faithfully and `registryFor` then returns null for it: the app declines to map
it to a URL rather than resolving the address and inspecting what comes back. And the OCI
spec's own way of finding a token endpoint — read `realm` off a `WWW-Authenticate`
challenge — is not used at all, because a realm is a URL chosen by whatever answered. There
are three registries; their realms were verified once and written down.

Four further properties keep the shape narrow:

- **`redirect: "manual"`, and any 3xx is `unknown`.** This is the one place a registry could
  still choose a URL for this app, so it does not get to. A manifest `HEAD` has no
  legitimate reason to redirect; a `location` is never read, and the bearer token is never
  re-sent off-origin.
- **No credential is ever sent.** The pull tokens are anonymous, minted per request, scoped
  to one repository, and never returned to a browser. No Railway token, cookie or session
  value goes anywhere near this path.
- **No response body reaches the browser.** The manifest request is `HEAD`, so there is no
  body to read; the only body read anywhere is a token JSON, and what the route returns is
  one of four enum members. Nothing a registry wrote can render.
- **`HEAD`, never `GET`.** Measured against `library/redis:7-alpine`: two `HEAD`s left
  `ratelimit-remaining` at `100;w=3600`, a `GET` took it to 99. Docker Hub's anonymous pull
  budget is per source IP and every user of a deployed instance shares one, so a `GET` here
  would spend someone else's quota per keystroke.

**Environment variables are user-supplied, and were not always.** Until T-487 the client
sent neither a preset id nor a variable: the environment was derived server-side from the
submitted image alone, which made "a caller cannot inject environment into a service" true
for free. That was a real property, and it is gone deliberately — a spin-up form that
cannot set a variable is a form that cannot start most images. It is replaced, not deleted,
by three bounds that do not overlap:

- **Shape.** The table above. A refused row produces a form error attributed to that row,
  and no mutation is attempted.
- **Authority.** `resolveVariables` (`src/lib/railway/secrets.ts`) is the only thing in the
  app that mints a credential. It mints only for a name `src/lib/presets.ts` declares
  generated _for the submitted image_, and only when that row's value is left blank. So
  "generate me a secret" is not a request shape: a row named `MY_KEY` left blank on
  postgres gets an empty string, not a password. A generated value is returned to the
  browser on no path, and `e2e/containers.spec.ts` asserts the rendered page never contains
  it. A user who needs to know a password types their own — generation is the default for
  the users who do not, which is why not showing it costs nothing.
- **Record.** `container.created` names only the preset-derived variables and counts the
  rest; see the logging bullet under Operational notes.

**The two names carry no charset rule, on purpose.** They are the only user input here that
is not pattern-matched, and the reason is that neither is ever interpreted: a project name
is not slugged into a service name, not prefixed, and not interpolated into a path, a URL
or a shell — Railway stores it and renders it back. The bound that matters is length, and a
charset rule would only reject names people legitimately write. Compare the container name
directly above, which `toManagedName` turns into a service identifier and therefore does
constrain.

**Neither can be deleted from this app.** `projectDelete` and `environmentDelete` are absent
from `src/lib/railway/operations.ts` entirely rather than guarded behind the ownership
prefix, so no request shape reaches them. That is also why projects and environments carry
no `MANAGED_PREFIX`: the marker gates destroy, and there is no destroy to gate. Deleting a
project would take every service, environment and volume in it — including ones this app
did not create — which is a different blast radius from deleting one service, and not one a
single mis-aimed click should be able to reach.

**The blast radius did not change**, and that is what makes the trade defensible. Every
mutation carries the requester's own token, so injecting environment means injecting it
into a service they asked this app to create, in a project their own Railway grant already
reaches. Railway is still the gate.

**`RAILWAY_*` is refused** because Railway injects that namespace itself and
`variableCollectionUpsert` runs with `replace: false`, so a collision is a silent merge in
one direction or the other and the loser is invisible.

**Neither new pattern is ReDoS-able**, for the same reason the image regex is not: both are
linear, with no nested quantifier and disjoint atom classes.

## Findings and dispositions

| #   | Finding                                                                                                                                        | Found at                                                                      | Fixed in                                                                              | Severity |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------- |
| 1   | No security headers at all — no CSP, HSTS, nosniff, frame-ancestors, Referrer-Policy; `X-Powered-By` emitted                                   | `next.config.ts`, `src/proxy.ts`                                              | `src/lib/security-headers.ts`, `next.config.ts`, `src/proxy.ts`, `src/app/layout.tsx` | High     |
| 2   | The OAuth callback logged `error.cause` wholesale, and that object can be the parsed token response                                            | `src/app/api/auth/callback/route.ts:47`                                       | `src/lib/auth/redact.ts`                                                              | Medium   |
| 3   | Railway's raw GraphQL error text was rendered to the browser through `errors.api.graphqlDetail`                                                | `src/lib/railway/errors.ts:79`                                                | `src/lib/report-error.ts`, `src/lib/railway/errors.ts`                                | Medium   |
| 4   | `errors.streamInterruptedDetail` interpolated a `ws` failure, which carries the upstream's resolved address                                    | `src/lib/railway/deployment-monitor.ts:172`                                   | `src/lib/railway/deployment-monitor.ts`                                               | Medium   |
| 5   | `/api/health` returned the full zod issue list, unauthenticated, naming every misconfigured variable                                           | `src/app/api/health/route.ts:16`                                              | `src/app/api/health/route.ts`                                                         | Medium   |
| 6   | `/api/streams/[deploymentId]` took the id unvalidated, had no per-user cap, and polled a nonexistent deployment for the full 15-minute ceiling | `src/app/api/streams/[deploymentId]/route.ts:25`, `deployment-monitor.ts:123` | `src/lib/stream-slots.ts`, `src/lib/sse.ts`, `src/lib/validation.ts`                  | Medium   |
| 7   | Session cookie had no `__Host-` prefix, and `APP_URL` could be `http://` on a real host                                                        | `src/lib/auth/session.ts:87`, `src/env.ts`                                    | `src/lib/auth/session.ts`, `src/env.ts`                                               | Medium   |
| 8   | Logout POST had no origin check, so a cross-site form could sign a user out                                                                    | `src/app/api/auth/logout/route.ts`                                            | `src/app/api/auth/logout/route.ts`                                                    | Low      |
| 9   | No dependency audit in CI                                                                                                                      | `.github/workflows/ci.yml`                                                    | `.github/workflows/ci.yml`                                                            | Medium   |
| 10  | Adopting pino would have re-opened finding 2: its stock `err` serializer walks `Error.cause`, and both error classes here assign it            | pino's `pino-std-serializers` default                                         | `src/lib/log/serialize-error.ts`, `src/lib/logger.ts`, `eslint.config.mjs`            | Medium   |

### Notes on the two worth explaining

**Finding 2** is the one that mattered most despite its narrow trigger.
`oauth4webapi@3.8.6` (`build/index.js:1276`) throws
`UnsupportedOperationError("unsupported \`token_type\` value", { cause: { body: json } })`where`json`is the parsed token response — a live access token and refresh token. Other
branches put the decoded id_token claims there. The handler logged`cause`verbatim, and
Railway retains stdout, so one such line would have outlived the request that produced
it.`src/lib/auth/redact.ts`reads an allow-list and never touches`cause`.

**Finding 3 and 4** removed detail the app genuinely needed, so it moved rather than
disappeared. `reportError` writes the verbatim failure to the deployment log against an
8-character incident id and returns only a catalog key plus that id. A screenshot now
points at a log line; before, the screenshot _was_ the only evidence, and it was also
the leak.

**Redaction is not the same as silence, and the first pass conflated them.** Every
GraphQL failure resolved to one sentence — "Railway rejected the operation. Reference
…" — which is a redaction so complete that the user cannot tell a missing permission
from an outage, and so cannot tell whether to retry, re-authorize, or stop. The upstream
text is still never rendered; what changed is that the _cause_ is now classified
server-side and mapped to its own sentence: a rejected credential, a scope Railway
withheld (named, from the refused field's `path`), a rate limit, an outage. The incident
id rides along with all of them rather than only the two GraphQL keys, so the log join
works for every failure a user can screenshot.

**Finding 10 is finding 2 arriving through a different door**, and it is worth stating
because it is what a routine "add structured logging" change would have shipped. pino's
default `err` serializer walks `Error.cause` recursively; `RailwayApiError` and
`SessionExpiredError` both assign `this.cause`, and it is an enumerable own property, so
anything that stringifies an error wholesale emits it. `describeOidcFailure` guards one
call site; the logger is reachable from every one.

The rule from finding 2 — read an allow-list, never stringify an object you did not take
apart field by field — now has four enforcers, in the order they fire:

1. **A type.** `log.*` accepts scalars only, with `error` as the single sanctioned
   non-scalar key. Passing a session, a token response or a bare `Error` under any other
   name is a compile error. This matters because pino's serializers are keyed by field
   _name_: `{ error }` rather than `{ err }` would get no serializer at all, and the leak
   is one character wide.
2. **`errorFields`** (`src/lib/log/serialize-error.ts`) reads a named allow-list, never
   touches `cause` at any depth, and never enumerates keys or `String()`s a non-Error
   object.
3. **`describeOidcFailure`** still owns the OIDC path, so the raw error never enters the
   logging path there at all.
4. **pino `redact` paths** as a labelled net — one level deep, so it is a backstop and the
   comment says so rather than pretending otherwise.

Three canary tests, at three layers: the serializer directly, the `log.*` facade, and the
pre-existing one over the real callback handler, which searches the raw written bytes
rather than a parsed record. `no-console` is now an error across `src/**` (one documented
exception, the browser-side error boundary), because a stray `console.error(error)` is how
this class of leak gets in.

## What was already sound

Recorded because a review that reports only problems misrepresents the system.

- **Authorization does not depend on the proxy.** Every protected path re-checks:
  `loadDashboardShell`/`loadContainers` return null without a session, both Server
  Actions call through `requireSession`, the SSE route 401s. A proxy bypass yields
  nothing.
- **`spinDown` cannot be tricked into destroying what the app did not create.** It
  re-fetches from Railway and tests ownership on Railway's own response, never on
  client-submitted data. A `serviceId` from a different project than the submitted
  `projectId` fails closed at the lookup.
- **No GraphQL injection.** All documents are static; every dynamic value is a variable.
- **No SSE frame injection.** `JSON.stringify` escapes the newlines that would let a log
  line forge a `done` event, and the event _name_ comes from a closed union — so a
  container cannot print its way to a synthetic stream event.
- **No XSS.** The single `dangerouslySetInnerHTML` is a module constant with no
  interpolation; all upstream text renders as React text children.
- **The image-reference regex is not ReDoS-able.** Its separator and atom classes are
  disjoint, so the partition of any input is unique. Measured: 192 kB of adversarial
  input in 0.99 ms.
- **The OIDC flow is correct.** State is verified and fails closed, PKCE is bound to the
  browser through httpOnly cookies, there is no open redirect, and the transient cookies
  are deleted on every exit path including success.
- **No secret has ever been committed**, no `NEXT_PUBLIC_` anywhere, and no server module
  reaches a client bundle. The first of those was verified by hand against full history and
  is now gated: the `secrets` job in `.github/workflows/ci.yml` runs gitleaks over
  `--log-opts=--all` on every push, pull request and weekly cron. 72 commits, no findings,
  when the gate was added. Scanning the whole history rather than the pushed range is what
  catches a force-push that rewrites a secret into a branch nobody reads, and it is what
  keeps this line a statement about the repository rather than about one afternoon.

## Accepted risks

**A user can set any environment variable on a service they create.** The form validates
shape, not meaning: nothing stops `LD_PRELOAD`, `NODE_OPTIONS`, or a variable that makes an
image behave in a way its own documentation does not describe. Accepted rather than
mitigated, because the service is the requester's own, created with the requester's own
token, in the requester's own project — the same person can set the same variable from
Railway's own dashboard in fewer clicks. An allow-list of "safe" names would be a guess
about images this app has never heard of, and would break the feature's actual use case on
its first day. What is not accepted, and is enforced: the name charset, the counts and
sizes, the `RAILWAY_` namespace, and values reaching no log.

**The create record no longer names every variable a service was created with.**
`container.created` logs `variable_names` for preset-derived keys only — a closed set drawn
from the catalog — plus `user_variable_count`. User-supplied names are unbounded and
attacker-chosen in exactly the way the rejected `deploymentId` is, and a field an operator
greps is not where that belongs. The trade is deliberate and it is a real loss: the audit
trail says how many variables a user set, not which.

**Deployment-event text is rendered; GraphQL and `ws` failure text still is not.** A failed
row shows the free text Railway puts on the failing `DeploymentEvent` — `payload.error`,
`payload.reason` or `payload.detail` — which is the first upstream-authored string to reach
the browser since findings 3 and 4. It is a different class from what those closed. A GraphQL
error envelope is _about this app_: it names internal fields and, on a schema rejection,
quotes the document we sent. A `ws` failure carries the resolved address of the upstream host.
A deployment event describes **the requester's own deployment**, in the requester's own
account, and sits beside container stdout that `LogPane` already renders verbatim line by
line. It is bounded before it leaves the server (`src/lib/railway/failure-reason.ts`): first
non-empty line only, C0/C1 control characters and Unicode line separators replaced with
spaces, whitespace collapsed, capped at `STREAM.FAILURE_REASON_MAX`. It renders as a text
child of a `<p>`, so React escapes it — never a URL, an attribute, or HTML, and
`container-row.test.tsx` asserts that with a markup payload. It is not logged, only its
length. Transport-level failures on that same request are unchanged: they never reach the
browser, and the row falls back to its own sentence.

**No app-level ownership check on `deploymentId`.** The stream endpoint validates the
id's shape and caps concurrency, but it does not verify that the deployment belongs to
the selected project. It deliberately does not: every upstream call carries the
requester's own Railway token, so this is not a confused deputy — guessing another
tenant's id yields whatever Railway returns for _your_ token, which is an authorization
error. Railway is the gate. An app-level check would cost a round trip per stream open
and would imply a guarantee this app is not the one making. The consequence, stated
plainly: a user can stream logs from any deployment their own Railway grant reaches,
including projects never selected in the picker.

**`style-src 'unsafe-inline'`.** Unavoidable, for two independent reasons. A CSP nonce
can never authorize a `style=` attribute — those are governed by `style-src-attr`, which
has no nonce concept — and Radix writes inline styles onto popper content and Select's
internals. Separately, opening a dialog makes `react-remove-scroll` inject a `<style>`
element at runtime whose nonce hook is not reachable through Radix's public API.
Removing it produces 12 `style-src-attr` violations on the dashboard alone, which is
how `e2e/security.spec.ts` was checked. This is a materially weaker concession than
`script-src 'unsafe-inline'`: it enables CSS-based exfiltration, not code execution.

**`server-only` is not on `src/lib/auth/session.ts`.** The package's exports map resolves
to a bare `throw` outside the `react-server` condition, and two legitimate callers
resolve it that way: `src/proxy.ts`, which runs in the middleware layer, and
`scripts/probe-projects.ts`, which runs under plain `tsx`. Note which modules _do_ carry
`server-only` — exactly the ones the proxy does not import. The boundary is enforced from
the other side instead, by a `no-restricted-imports` rule in `eslint.config.mjs` covering
`src/components/**` and `src/hooks/**`. Do not "fix" this without running
`pnpm probe:projects` first.

**`SessionExpiredError` carries the raw openid-client error on `.cause`**
(`src/lib/auth/refresh.ts`). Nothing logs it today. If that changes,
`describeOidcFailure` is the tool to reach for — the hazard in finding 2 is one
`console.error(error)` away from returning.

**`SESSION_SECRET` is length-checked, not entropy-checked.** HKDF does not stretch, so a
32-character passphrase is offline-brute-forceable against a single captured cookie, and
success yields both Railway tokens plus the ability to forge sessions. `.env.example`
documents `openssl rand -base64 32`; that guidance is the actual control.

**Sign-out cannot end the Railway grant.** It clears the session cookie and nothing else,
so the tokens inside it become unreachable, but the authorization at Railway survives
until it expires or the user removes the app. This is the one accepted risk with no
mitigation available at all: Railway's discovery document publishes no
`revocation_endpoint` and no `end_session_endpoint`, and the paths a provider of this
shape would put them on — `/oauth/token/revocation`, `/oauth/revoke`,
`/oauth/revocation`, `/oauth/session/end`, `/oauth/logout` — answer 404 to a POST that
`/oauth/token` answers with `invalid_request`, so a client-side revoke has nothing to
call. What is done instead is to stop the gap being invisible: the landing page states
both halves of what sign-out did and links to Railway's account settings, and
`ABSENT_ENDPOINTS` in `scripts/verify-schema.ts` fails CI the day either endpoint
appears. The residual cost is an abandoned refresh token per sign-out against Railway's
cap of 100 live tokens per authorization (`src/lib/auth/refresh.ts`), which only the user
can reclaim.

**The image existence check is advisory, and every failure is silent.** A registry that
rate-limits, times out or is down produces `unknown`, which renders nothing — so an outage
can never be the reason a spin-up did not happen. The cost is that the check is not
authoritative in the other direction either: a warning's absence is not a promise the image
exists, and a manifest that is there now can be gone at deploy time.

**"No such repository" and "private repository" are one answer, deliberately.** All three
registries refuse an anonymous read of a repository that does not exist with 401 or 403,
not 404 — Docker Hub issues a token with an empty `access` claim and then refuses with
`insufficient_scope`, ghcr.io refuses at the token endpoint with `DENIED`. There is no
registry-API way to tell the two apart without authenticating as someone who can see the
private one, which this app never does. The warning covers both, which is honest: this app
collects no registry credentials, so a private image fails to deploy exactly as an absent
one does. `hub.docker.com/v2/repositories/…` would distinguish them on Docker Hub and was
rejected — a fourth outbound host on a proprietary non-OCI API with no compatibility
promise, answering a question whose two answers are treated identically here.

**DNS and CA trust for the four registry hosts.** If DNS for `registry-1.docker.io`,
`auth.docker.io`, `ghcr.io` or `quay.io` were hijacked _and_ the attacker held a
CA-trusted certificate for that name, this app would make an anonymous, bodyless `HEAD`
request to it and read a status code. It carries no credential, follows no redirect and
reads no body, so the disclosure is that this server exists and somebody typed an image
reference.

A `dns.lookup` pre-flight refusing private and link-local addresses was considered and
**rejected as theatre**. `fetch` resolves independently of any such check, so the address
validated is never the address connected to — it is TOCTOU by construction, and caching the
result to make it affordable widens the window rather than narrowing it. Closing it
properly means a custom `undici.Agent` filtering the real peer address, which is a runtime
dependency this repo avoids on principle, to defend a threat that requires hostile DNS for
GitHub's own registry. **TLS is the control that actually applies here**: a rebound A
record cannot present a valid certificate for the name, and cloud metadata services serve
plain HTTP with no CA-issued certificate at all. The allowlist is what stops user input
choosing a host; TLS is what stops the host being someone else. Neither is a lookup.

**The answer cache is shared across every user of an instance.** That is deliberate and
leaks nothing: each entry is an anonymous answer about a public repository, with no
per-user variation to observe. Partitioning it per session would multiply this server's
egress by the number of people typing the same reference and buy no privacy. What it does
mean is that one user can learn, from timing, that another recently asked about the same
public image — which is a fact about Docker Hub, not about them.

**The stream cap and the idempotency map are in-memory and per replica.** Honest rather
than lazy: SSE pins a client to one replica, which is why the README already describes this
as a single-replica app. If that changes, both move to shared state along with everything
else. The idempotency map (`src/lib/idempotency.ts`) is keyed `userId:key`, so one user can
neither claim nor observe another's submission, and what it holds for
`IDEMPOTENCY.RETAIN_SECONDS` is an `ActionResult` — catalog copy and Railway ids. No
credential reaches it, because a generated password is returned to no browser on any path.

**A repeat submission after that window creates a second container.** So does one that
lands either side of a deploy. The form only re-mints its key on success, which is what
makes a retry after a failure a retry rather than a second container, and both windows are
far narrower than the name check they replaced — which was not a lock at all. See ADR-12.

**Three dev-only advisories** under `@lhci/cli` — `tmp` (GHSA-ph9p-34f9-6g65, high),
`uuid` (GHSA-w5hq-g745-h8pq, moderate), `tmp` (GHSA-52f5-9888-hmc6, low). None is
reachable at runtime: `@lhci/cli` is a devDependency invoked only by `pnpm lighthouse`.
`pnpm audit --prod` is clean, and that is what CI gates on. Reviewed 2026-08-12.

**The app trusts the host its proxy reports.** The origin it serves — the OIDC
`redirect_uri`, every redirect, the cookie name and `secure` flag, the logout CSRF
comparison, the CSP — is derived per request from `x-forwarded-host` else `host`
(`src/lib/origin.ts`). Anyone who can reach the container directly can write those headers.
Four things make that acceptable here, each checkable:

- **A spoofed origin cannot receive an authorization code.** Railway's OAuth app enforces
  its registered `redirect_uri`s, so an unregistered one is refused at the provider.
- **A spoofed host plants a cookie only in the spoofer's own browser.** The cookies carry
  the `__Host-` prefix, which is host-scoped by definition.
- **There is no shared cache** in front of this app for a poisoned absolute URL to persist
  in.
- **There is no email, magic-link or notification path** that could carry a spoofed origin
  to somebody else. The only flow is the OAuth round trip.

Two rules bound it further: an origin must be https unless the host is loopback, so a
forwarded `http` scheme is refused rather than allowed to strip `Secure`; and `APP_ORIGINS`,
when set, is an allowlist that refuses anything not on it. The default is open because that
is what lets a new custom domain work with no configuration — see ADR-13. A refusal records
a bounded reason and never the host, for the same reason the rejected `deploymentId` is
kept out of the log; the configured allowlist is on the `boot` line instead.

**Unfixed CVEs in the deployment image are not gated.** Trivy runs with
`--ignore-unfixed`, so an advisory against the Alpine base with no patched version
available does not fail the build. The reasoning is the one `--prod` makes about
`pnpm audit`: a gate that goes red for something no commit can address is a gate people
route around, and routing around it is what loses the findings that do have fixes.
Reviewed 2026-08-14 — with the base image at `node:22.23.2-alpine`, the fixable
HIGH/CRITICAL count is zero, including the app's own production tree.

## Operational notes

- **Deploying the `__Host-` cookie change invalidates every existing production session
  once.** That is deliberate — accepting the old unprefixed name as a fallback would
  defeat the point of the prefix. Users sign in again; nothing else is affected.
- **The served origin must be https** anywhere but loopback. It decides `secure` on the
  session cookie _and_ whether the `__Host-` prefix applies, so an http origin silently
  downgrades the session to a cleartext, unprefixed cookie. `APP_URL` is refused at boot if
  it says otherwise, and a forwarded `x-forwarded-proto: http` on a public host is refused
  per request.
- **Sessions are per domain.** `__Host-` binds a cookie to one origin, so a user signing in
  on `trains.schupke.io` is not signed in on the generated `*.up.railway.app` domain. That
  is the prefix working, not a defect.
- **Every domain the app is reached on needs its own `/api/auth/callback`** registered on
  the Railway OAuth app. Sign-in follows the domain the request arrived at, so an
  unregistered one is rejected by Railway with its own error rather than by this app.
- **Incident ids** are 8 hex characters and appear in the UI as "Reference abc12345".
  They are now a first-class `incident` field, so `jq 'select(.incident=="abc12345")'`
  works as well as `grep`.
- **Logs are structured JSON on stdout.** Recorded: the OIDC subject id, project /
  environment / service / deployment ids, image references, incident ids, the
  preset-derived environment variable names on a spin-up — a closed set drawn from the
  catalog — and an event name per line. Never recorded: email, display name, profile image,
  access, refresh or id tokens, `Error.cause`, the sealed cookie, container stdout,
  environment variable **values** of either origin, or user-supplied variable **names**.
  Auth events
  (sign-in, sign-out, refresh, refresh failure, CSRF rejection) and state-changing
  actions (`container.created`, `container.create_failed`, `container.destroyed`,
  `container.destroy_refused`) are logged at `info` or `warn` — this is the audit trail
  Railway does not keep once a service is deleted. A create is recorded whether or not the
  deploy that follows it succeeds: an orphaned service is the case the record is most
  needed for, and `outcome` on `container.created` says which one it was.
- **The image reference is not logged either**, for the same reason and more sharply:
  `/api/image-check` fires on every settled keystroke of every signed-in visitor, so the
  reference is both unbounded and high-volume. `image.checked` carries the registry id, the
  outcome, whether it was cached and a duration — four closed sets and a number.
  `image.check_rejected` carries a reason and `ref_length`.

- **Docker Hub echoes this server's egress IP** in `docker-ratelimit-source` on every
  response, which is how the per-source-IP nature of its limits was confirmed rather than
  assumed. It is our own address, so it is not a disclosure — but it is the reason the
  answer cache and the per-registry cool-off exist at all.

- **The rejected `deploymentId` is deliberately not logged.** It is an unbounded,
  attacker-controlled string straight off the URL, and putting it in a field an operator
  greps is the injection surface the validator exists to close. `id_length` carries the
  diagnostic content instead.
- **`next build` copies `.env` into the standalone output, and `postbuild` deletes it.**
  `output: "standalone"` copies `.env` and `.env.production` next to the generated
  `server.js`, which then does `process.chdir(__dirname)` before listening — so Next loads
  env from there. `.dockerignore` keeps `.env` out of the image build context, but that rule
  does not reach a directory produced inside the build, and it does not reach a developer
  machine at all: `pnpm test:e2e` and `pnpm serve:e2e` run that same server against the
  fixture, and any variable the harness does not set explicitly would have fallen through to
  a real Railway account. `scripts/pack-standalone.ts` removes it. Three places now exclude
  this one file, which is proportionate to the number of ways it has found out.
- **The image ships a traced `node_modules`, not an installed one** — 504 MB to 44 MB. What
  left with it: TypeScript, Playwright, the Babel closure and a native SWC compiler, none
  imported by the server, all of which `pnpm install --prod` was obliged to keep because
  pnpm had welded them into the identity of `next` and `next-intl` while resolving optional
  peers. Attack surface follows code volume, and this was most of the volume.
- **The deployment image is built, booted and scanned in CI**, by the `image` job, before
  it can reach Railway — every other gate could pass with a `Dockerfile` that fails at
  deploy. The base image is pinned by sha256 digest on both `FROM` lines, so the runtime
  cannot change without a commit, and Dependabot's `docker` ecosystem bumps it. The runtime
  stage removes npm, corepack and yarn: the base image ships all three, the app invokes
  none, and npm's bundled dependency tree is where every image-scan finding otherwise comes
  from. That removal writes whiteouts rather than reclaiming space — the bytes stay in the
  base layer — so it is a surface change, not a size one.
- **The image carries OCI labels**, including `org.opencontainers.image.revision` from
  `RAILWAY_GIT_COMMIT_SHA`, the same value the logger emits as `version`. A running process
  reporting its own commit and an artefact stating which commit produced it are different
  claims; the second is the one that survives the process.
- **`LOG_LEVEL` is read straight from the environment**, not through `src/env.ts`, and an
  unrecognised value clamps rather than throwing. `/api/health` exists in order to log
  `env()` failing, so a logger that depended on `env()` succeeding could not report the
  one failure it is there for. Same reason `withRequestScope` catches `headers()`.

## Reporting a vulnerability

Open a GitHub issue for anything already public, or contact the repository owner
directly for anything that is not. There is no bug bounty.
