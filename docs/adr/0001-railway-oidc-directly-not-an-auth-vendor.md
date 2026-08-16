# ADR-1 — Railway OIDC directly, not an auth vendor

**Status:** accepted · **Decided:** 2026-08-14

## Context

The app is multi-tenant: it acts on **the visitor's** Railway account, not on a token I own.
That makes auth a capability-delegation problem, not a login problem. What it needs on every
request is the visitor's Railway access token, live — and Railway rotates refresh tokens on
every use.

Railway is a fully compliant OIDC provider — discovery at
`https://backboard.railway.com/oauth/.well-known/openid-configuration` (note the `/oauth`
segment; the domain root 404s), with JWKS and PKCE `S256`.

## Decision

**Talk to Railway's OIDC directly.** `openid-client` for the flow, and the session is an
encrypted (`dir` + `A256GCM`) JWE cookie via `jose`.

**Two scopes matter, not one.** Railway's prose scope table lists only `viewer` and `member` for
projects; `project:admin` appears in the live discovery document's `scopes_supported`.
`pnpm verify:schema` asserts it is still advertised.

`workspace:viewer` is the second, and it is not optional despite reading as though it were.
Railway scopes workspaces separately from projects, so a token holding `project:admin` alone has
`me.workspaces` refused outright — and a refusal in a document that also asked for the personal
project list discards both. The scope closes that; independent per-source documents keep a future
refusal from taking a whole dashboard load with it.

**The consent screen appears on every sign-in, because that is Railway's price for a refresh
token.** Railway issues one only for an authorization carrying both the `offline_access` scope
and `prompt=consent`, so `/api/auth/login` sends the parameter unconditionally. Omitting it was
tried, on the reading that Railway would re-grant silently for a user who had already
authorized: the silent grant came back without a refresh token, the callback retried with
consent forced, and the user reached the same screen one redirect later. The retry still
exists for a grant that declines offline access at the screen, guarded by a cookie so it
cannot loop. `?consent=1` now records which attempt is the retry rather than changing what is
sent.

## Alternatives rejected

**Clerk.** There is exactly one identity provider and it is the same service that grants the API
capability. Clerk would sit between the app and a token it needs on every request, while
explicitly not refreshing that token on its own — you still write the refresh logic, just further
from the thing that needs it.

**Auth.js.** Three reasons, in order of weight:

1. **It would not remove the part that is actually hard.** In Auth.js, keeping a rotating Railway
   token live is a `jwt` callback you write yourself, so the refresh logic survives the adoption;
   it just moves further from the code that depends on it.
2. **Railway's discovery document fails RFC 8414 issuer validation** — it is served from
   `/oauth/.well-known/openid-configuration` but declares `issuer` as the bare domain. Anything
   built on `openid-client`, Auth.js included, needs the endpoints pinned by hand
   (`src/lib/auth/oidc.ts`). The escape hatch is most of the implementation.
3. **v5 is still `5.0.0-beta.x`** and unproven against Next 16.

## Consequences

- **The implementation is hand-rolled and it is not small.** `src/lib/auth/**` plus the three
  auth route handlers, with `src/proxy.ts` beside them; there are more lines of test than of
  implementation. `wc -l` over those paths is the honest way to check the ratio rather than a
  figure quoted here.
- **Session encryption, CSRF and cookie chunking are hand-rolled** rather than inherited. Two
  consequences of that are recorded in [Limitations](../limitations.md#auth): there is no `nonce`
  in the flow, and sign-out is local only.
- **Refresh has to live somewhere that can write a cookie**, which is
  [ADR-2](0002-token-refresh-runs-in-the-proxy-layer.md).

---

[All decisions](README.md) · [Walkthrough](../../walkthrough.md) · [Railway Freight Loader](../../README.md)
