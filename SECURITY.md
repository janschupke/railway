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

Five things cross from a browser into a Railway mutation. None is trusted; each is
bounded.

| Input                 | Bound                                                                                                                              | Where                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Image reference       | `IMAGE_PATTERN`, 255 characters                                                                                                    | `src/lib/validation.ts`                               |
| Container name        | 40 characters, and prefixed before it is sent                                                                                      | `src/lib/validation.ts`, `src/lib/railway/managed.ts` |
| Environment variables | POSIX name charset, 64 / 2048 characters, 25 rows, 16 000 characters in total, no duplicates, no line breaks, no `RAILWAY_` prefix | `src/lib/validation.ts`                               |
| Project name          | 64 characters, trimmed; not prefixed and not slugged                                                                               | `src/lib/validation.ts`                               |
| Environment name      | 32 characters, trimmed; not prefixed and not slugged                                                                               | `src/lib/validation.ts`                               |

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

**The stream cap is in-memory and per replica.** Honest rather than lazy: SSE pins a
client to one replica, which is why the README already describes this as a single-replica
app. If that changes, this moves to shared state along with everything else.

**Three dev-only advisories** under `@lhci/cli` — `tmp` (GHSA-ph9p-34f9-6g65, high),
`uuid` (GHSA-w5hq-g745-h8pq, moderate), `tmp` (GHSA-52f5-9888-hmc6, low). None is
reachable at runtime: `@lhci/cli` is a devDependency invoked only by `pnpm lighthouse`.
`pnpm audit --prod` is clean, and that is what CI gates on. Reviewed 2026-08-12.

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
- **`APP_URL` must be https** anywhere but loopback, and the app now refuses to start
  otherwise. That single variable decides `secure` on the session cookie _and_ whether
  the `__Host-` prefix applies, so an http value silently downgraded the session to a
  cleartext cookie.
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
