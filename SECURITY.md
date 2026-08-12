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
- **No secret has ever been committed** (verified against full history), no
  `NEXT_PUBLIC_` anywhere, and no server module reaches a client bundle.

## Accepted risks

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

## Operational notes

- **Deploying the `__Host-` cookie change invalidates every existing production session
  once.** That is deliberate — accepting the old unprefixed name as a fallback would
  defeat the point of the prefix. Users sign in again; nothing else is affected.
- **`APP_URL` must be https** anywhere but loopback, and the app now refuses to start
  otherwise. That single variable decides `secure` on the session cookie _and_ whether
  the `__Host-` prefix applies, so an http value silently downgraded the session to a
  cleartext cookie.
- **Incident ids** are 8 hex characters and appear in the UI as "Reference abc12345".
  `grep` the deployment log for that string to find the verbatim upstream failure.

## Reporting a vulnerability

Open a GitHub issue for anything already public, or contact the repository owner
directly for anything that is not. There is no bug bounty.
