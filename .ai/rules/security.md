---
meta:
  updated: 2026-08-15
---

# Security

[SECURITY.md](../../SECURITY.md) is the record — the OWASP review, the ten findings with
the file that fixed each, what was already sound, and the accepted risks with their
reasoning. This file is the working rule set. **Read `SECURITY.md` before changing anything
on an auth, session, header or stream path**, because most of what looks like a
simplification there is a fix.

## The threat model, in one line

The app is multi-tenant and public, and the credential it holds is **delegated authority
over someone else's Railway account**. A session leak costs another person's infrastructure,
not a row in a database this app owns.

Railway is the authorization boundary for resources — every upstream call carries the
requester's own token, so this app cannot grant access the user does not already have. What
it does add is a refusal: it will not _use_ that access on anything it did not create.

## The token never leaves the server

- It is sealed into a JWE cookie (`src/lib/auth/session.ts`), key derived from
  `SESSION_SECRET` via HKDF.
- No `NEXT_PUBLIC_*` variable exists, and none should. Nothing derived from the token may
  reach a client bundle or a rendered response.
- Client components get what they need as props. The import ban in `eslint.config.mjs`
  covering `src/components/**` and `src/hooks/**` is the enforcement — see
  [architecture.md](architecture.md).
- The browser never opens a socket to Railway. SSE downstream, WebSocket upstream, precisely
  so the credential stays server-side.

## Never read, echo, or commit `.env`

`.env` exists on disk and is gitignored (`.env*` ignored, `!.env.example` re-included). Only
`.env.example` is tracked. **`.dockerignore` excludes it too, and
`scripts/pack-standalone.ts` deletes the copy `next build` makes** — three places, because
the file has three ways of escaping.

That last one is not hypothetical. `output: "standalone"` copies `.env` and
`.env.production` into `.next/standalone`, and `server.js` runs `process.chdir(__dirname)`
before listening — so Next loads env from there. Left alone it would put this machine's real
Railway credentials next to the server that `pnpm test:e2e` and `pnpm serve:e2e` run against
the fixture, where any variable the harness does not set explicitly falls through to a real
account. It is removed rather than ignored: a file that must not be read is worse than one
that is not there. The deployment's only configuration channel is service variables. No secret has ever been committed, and the `secrets` job in
`ci.yml` is what keeps that true rather than merely checked once: gitleaks over
`--log-opts=--all`, every run, on the whole history rather than the pushed commits. CodeQL
does not do this and never did. When you need to know what a variable is for, read
`src/env.ts` or `.env.example`, not `.env`.

The gate arrived while the repository was clean, which is the only moment a secret scanner
is prevention. If it ever fires, the commit is not the fix — the credential is already
public and has to be rotated first.

## Authorization is re-checked everywhere, not delegated to the proxy

A proxy bypass must yield nothing. `loadDashboardShell` and `loadContainers` return null
without a session, both Server Actions go through `requireSession`, and the SSE route 401s.
**A new protected surface re-checks too.** Do not add a route that trusts the proxy ran.

`spinDown` re-fetches from Railway and tests ownership on **Railway's own response**, never
on client-submitted data. A `serviceId` from a different project than the submitted
`projectId` fails closed at the lookup. Preserve that shape in any new destructive path.

## Removing a cookie

**Never `delete()` on a cookie jar that writes to the response.** It emits
`name=; Path=/; Expires=1970` with no `Secure`, and a `__Host-` cookie is rejected outright
unless it is `Secure`, `Path=/` and carries no `Domain` — so the browser discards the
removal and keeps the cookie. Use `clearCookie(jar, name, appUrl)`, which writes the removal
with the same options the cookie was set with.

That covers `response.cookies` and the `cookies()` jar from `next/headers`, which is
read-only in a Server Component but is a response jar inside a Server Action or Route
Handler — a delete there reaches the browser and meets the same rejection. The one exempt
call is `request.cookies.delete`, which edits the inbound request so the headers forwarded
to the render drop a cookie this layer has just invalidated; it sends nothing to the
browser. Write it as `request.` in full — the scan's exemption is that literal name.

This failed silently for every cookie the app removes. Sign out did not sign anyone out:
the session survived, the redirect to `/` found it, and `/` sent the user back to the
dashboard. Neither dev nor the e2e suite can see it — both run on `http://localhost`,
where `hostCookieName` returns unprefixed names and a plain delete works — so
`local/no-cookie-jar-delete` bans the call structurally instead, across every jar. It was
one regex over the literal `response.cookies.delete` for a while, and `clearSession()` in
`src/lib/auth/server.ts` sat outside it for exactly as long, deleting the session cookie
off the `next/headers` jar. It is a lint rule rather than a scan because the alias form is
the one that matters: `const jar = await cookies(); jar.delete(…)` needs the binding
resolved, and the regex standing in for that recognised only `const|let|var … = await
cookies(`. What `src/cookie-removal.test.ts` still asserts is what `clearCookie` writes,
which is a property of a function and is checked by calling it.

## Upstream failure text never reaches the browser

Railway's GraphQL errors name internal fields and, on a schema rejection, quote the document
sent. A `ws` failure carries the resolved address of the upstream host. Both used to render
verbatim (findings 3 and 4).

The detail moved rather than disappeared: `reportError` writes the full failure to the
deployment log against an incident id and returns a catalog key. See
[errors-and-logging.md](errors-and-logging.md).

Redaction is not silence, though — the _cause_ is classified server-side and mapped to its
own sentence (rejected credential, withheld scope, rate limit, outage) so the user can tell
whether to retry, re-authorize, or stop. Do not collapse those branches back into one
generic message.

**One exception, and it is narrow.** A failed row renders the text on Railway's failing
`DeploymentEvent`, bounded by `src/lib/railway/failure-reason.ts`. That is content about the
requester's own deployment, next to container stdout the log pane already shows verbatim —
not an error envelope about this app. The reasoning and the bounds are recorded as an
accepted risk in `SECURITY.md`; read it before extending the exception to anything else, and
note that the transport failures on that same request still go through `reportError`.

## One writer per header

- **CSP is written in `src/proxy.ts` only**, because it carries a per-request nonce.
  `src/lib/security-headers.ts` builds it.
- **Everything else is in `next.config.ts`** on `/:path*`: HSTS, `nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy`, COOP, `Permissions-Policy`, and
  `poweredByHeader: false`.
- **CORP is the one value that is not the same on every path.** `/:path*` gets
  `same-origin`. `/icon.svg` and `/favicon.ico` get `cross-origin`, because the app's mark
  is the only response here meant to be read by another origin — a README, a link preview
  — and both paths carry it: one is what the page declares, the other is what browsers ask
  for regardless. It is not CORS: no credentials, no readable body for script. Widening it
  to any other path means letting another site embed that response while a visitor's
  session cookie is live.

  The rules are ordered — a later value for the same key wins — so the blanket rule comes
  first. `src/app/security-headers.test.ts` asserts the order and both values;
  `e2e/security.spec.ts` reads them off a live response, signed out, along with the fact
  that the proxy matcher does not gate the icon. A grant on a path the proxy redirects is
  a header on a 307.

Two footguns in the CSP path, both load-bearing: the nonce must be set on
`request.headers` (Next parses it off the request header with `getScriptNonceFromHeader`
— that is the documented channel, not a workaround), and **no directive may sort before
`script-src` under a `startsWith` scan**, which is why there is no `script-src-elem`.

`style-src 'unsafe-inline'` is an accepted risk with two independent causes documented in
`SECURITY.md`: a nonce cannot authorize a `style=` attribute, and `react-remove-scroll`
injects a `<style>` element whose nonce hook Radix does not expose. Removing it produces a
page full of `style-src-attr` violations. Do not try.

## The request id is minted, and adopted only from behind the proxy

`src/proxy.ts` generates it and `headers.set` overwrites any inbound value unconditionally,
on every path the matcher covers. Taking a client-supplied `x-request-id` would otherwise put
attacker-chosen bytes into a field operators grep and give the log store an unbounded label.
The same reasoning applies to any new identifier you are tempted to read off a request.

**What a handler downstream reads is therefore the proxy's own value, and that is the whole
of why `trustInboundId: true` is safe.** This section used to say "minted, never adopted",
which reads as an absolute and is not one: every Server Action, both data loaders and all five
non-auth route handlers pass `trustInboundId: true`, because the
proxy has already overwritten the header before their handler runs. `resolveId` in
`src/lib/log/request-scope.ts` still holds the value to `REQUEST_ID_PATTERN` before accepting
it, so a bypass yields a fresh id rather than the caller's bytes.

The four handlers the matcher **excludes** are the ones that must not trust it, and they
pass `trustInboundId: false` for exactly this reason: `api/auth/login`, `api/auth/callback`,
`api/auth/logout` and `api/health`. Each says so at its own call site. A new route added
under `api/auth/**`, or any other path added to the matcher's exclusion list, inherits that
obligation — the proxy is not running, so the header is raw client input.

Relatedly: the rejected `deploymentId` is **deliberately not logged**. It is unbounded,
attacker-controlled string straight off the URL; `id_length` carries the diagnostic content
instead.

## Dependencies

`pnpm audit --prod --audit-level=high` gates CI. A new **runtime** dependency carrying a high
advisory breaks the build. The full-tree audit runs too but is advisory — three findings
under `@lhci/cli` are open and unreachable at runtime, and `--prod` re-evaluates
reachability every run, which an ignore-list of advisory ids would not.

Prefer not adding a runtime dependency at all. The GraphQL client is hand-rolled for reasons
argued in ADR-8.

## The image is scanned, and the two scans do not overlap

Trivy runs over the built image in the `image` job, gating on HIGH and CRITICAL **with a
fix available**. `--ignore-unfixed` is the same argument `--prod` makes above: a gate that
reports what no commit can address is a gate people learn to skip past, and they skip past
the actionable findings with it.

The division of labour is worth holding on to. `pnpm audit --prod` reads the lockfile and
knows which dependencies are production. Trivy reads the filesystem the image actually
ships and finds the operating-system layer, which no lockfile describes. Neither subsumes
the other, and the two disagreeing about the same package is information, not noise.

Two consequences for the `Dockerfile`:

- **The base image is pinned by digest**, on both `FROM` lines, and Dependabot's `docker`
  ecosystem bumps it. Pinning without bumping converts a supply-chain risk into a staleness
  one, and staleness is what this gate measures.
- **The runtime stage removes npm, corepack and yarn.** Every finding the scan reported
  before that line sat inside npm's own bundled tree — `tar`, `sigstore`, `brace-expansion`
  — none of it upgradable from here, none of it ever invoked. Do not put a package manager
  back into that stage.
- **The image ships a traced `node_modules`, not an installed one.** `output: "standalone"`
  took 480 MB of `node_modules` down to 38 MB, and with it went TypeScript, Playwright, the Babel
  closure and a native SWC compiler — none of which the server imports, all of which
  `pnpm install --prod` was obliged to keep because pnpm had written them into the identity
  of `next` and `next-intl`. Less code in the image is less code a scanner can find a CVE
  in, and this removed most of it.

## Outbound hosts are constants, and there are five

Railway, plus `auth.docker.io`, `registry-1.docker.io`, `ghcr.io` and `quay.io` for the
image existence check. **`src/lib/registry/registries.ts` is the only place a new one may be
added**, and adding one is a `SECURITY.md` change by the list below.

Three rules hold that boundary, and all three are load-bearing:

- **No host, port or scheme is derived from user input.** `IMAGE_PATTERN` admits a bare host
  as the first component, so `169.254.169.254/foo/bar` is a well-formed reference naming a
  registry. It parses fine and is then refused: `registryFor` returns null rather than
  resolving it. Refusing rather than resolving is what closes that SSRF — see
  [docs/limitations.md](../../docs/limitations.md#the-image-existence-check).
- **No host is derived from a registry _response_ either.** The OCI spec says to find the
  token endpoint by reading `realm` off a `WWW-Authenticate` challenge. It is not read.
  Three registries, three constants, verified once.
- **`redirect: "manual"`, and a 3xx is an unknown answer rather than a URL to follow.**
  Otherwise the last word on where a request goes belongs to whatever answered the previous
  one.

A `dns.lookup` pre-flight is **not** the guard here and was rejected as TOCTOU theatre —
`fetch` resolves independently, so the address checked is never the address connected to.
TLS is what stops a hijacked name being answered by someone else. See `SECURITY.md`.

## When a change is also a `SECURITY.md` change

Update the document when you add or alter:

- an OAuth scope, a cookie attribute, or a cookie name
- a security header, or a CSP directive
- a new outbound host
- what the deployment image contains, or which base image it starts from
- a new **input surface** — a field the browser can set that reaches an upstream mutation —
  or a widening of what an existing one accepts
- anything on an accepted-risk list — if you close one, move it out of that section

Accepting user-supplied environment variables on the spin-up form is why the input-surface
line is on that list: it changed the threat model and nothing else on the list would have
fired for it.

## Before you call this done

```sh
pnpm build && pnpm test:e2e e2e/security.spec.ts
```

`e2e/security.spec.ts` asserts the live headers and collects CSP violations from a real
page. The unit and canary layers:

```sh
pnpm test src/lib/security-headers.test.ts src/app/security-headers.test.ts \
  src/lib/auth/redact.test.ts \
  src/lib/log/serialize-error.test.ts src/lib/logger.test.ts \
  src/app/api/auth/callback/route.integration.test.ts
```

That last one searches the raw written bytes rather than a parsed record — it is the canary
over the real callback handler, and the leak class from finding 2 is exactly what it holds
shut.
