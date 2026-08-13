---
meta:
  updated: 2026-08-13
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
`.env.example` is tracked. No secret has ever been committed and history has been checked —
keep it that way. When you need to know what a variable is for, read `src/env.ts` or
`.env.example`, not `.env`.

## Authorization is re-checked everywhere, not delegated to the proxy

A proxy bypass must yield nothing. `loadDashboardShell` and `loadContainers` return null
without a session, both Server Actions go through `requireSession`, and the SSE route 401s.
**A new protected surface re-checks too.** Do not add a route that trusts the proxy ran.

`spinDown` re-fetches from Railway and tests ownership on **Railway's own response**, never
on client-submitted data. A `serviceId` from a different project than the submitted
`projectId` fails closed at the lookup. Preserve that shape in any new destructive path.

## Removing a cookie

**Never `response.cookies.delete(name)`.** It emits `name=; Path=/; Expires=1970` with no
`Secure`, and a `__Host-` cookie is rejected outright unless it is `Secure`, `Path=/` and
carries no `Domain` — so the browser discards the removal and keeps the cookie. Use
`clearCookie(response.cookies, name, appUrl)`, which writes the removal with the same
options the cookie was set with.

This failed silently for every cookie the app removes. Sign out did not sign anyone out:
the session survived, the redirect to `/` found it, and `/` sent the user back to the
dashboard. Neither dev nor the e2e suite can see it — both run on `http://localhost`,
where `hostCookieName` returns unprefixed names and a plain delete works — so
`src/cookie-removal.test.ts` bans the call structurally instead.

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
`SECURITY.md`. Removing it produces 12 `style-src-attr` violations on the dashboard alone.
Do not try.

## The request id is minted, never adopted

`src/proxy.ts` generates it. Taking a client-supplied `x-request-id` would put
attacker-chosen bytes into a field operators grep and give the log store an unbounded label.
The same reasoning applies to any new identifier you are tempted to read off a request.

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

## When a change is also a `SECURITY.md` change

Update the document when you add or alter:

- an OAuth scope, a cookie attribute, or a cookie name
- a security header, or a CSP directive
- a new outbound host
- anything on an accepted-risk list — if you close one, move it out of that section

A security claim that is no longer true is worse than no document.

## Before you call this done

```sh
pnpm build && pnpm test:e2e e2e/security.spec.ts
```

`e2e/security.spec.ts` asserts the live headers and collects CSP violations from a real
page. The unit and canary layers:

```sh
pnpm test src/lib/security-headers.test.ts src/lib/auth/redact.test.ts \
  src/lib/log/serialize-error.test.ts src/lib/logger.test.ts \
  src/app/api/auth/callback/route.integration.test.ts
```

That last one searches the raw written bytes rather than a parsed record — it is the canary
over the real callback handler, and the leak class from finding 2 is exactly what it holds
shut.
