# ADR-1 — Railway OIDC directly, not an auth vendor

The app is multi-tenant: it acts on **the visitor's** Railway account, not on a token I
own. That makes auth a capability-delegation problem, not a login problem.

Railway is a fully compliant OIDC provider — discovery at
`https://backboard.railway.com/oauth/.well-known/openid-configuration` (note the
`/oauth` segment; the domain root 404s), with JWKS and PKCE `S256`. So `openid-client`
talks to it directly, and the session is an encrypted (`dir` + `A256GCM`) JWE cookie via
`jose`.

**Why not Clerk:** there is exactly one identity provider and it is the same service
that grants the API capability. Clerk would sit between the app and a token it needs on
every request, while explicitly not refreshing that token on its own — you still write
the refresh logic, just further from the thing that needs it.

**Why not Auth.js.** Three reasons, in order of weight:

1. **Auth.js would not remove the part that is actually hard.** What this app needs is
   the visitor's Railway access token, live, on every request — and Railway rotates
   refresh tokens on every use. In Auth.js that is a `jwt` callback you write yourself,
   so the refresh logic survives the adoption; it just moves further from the code that
   depends on it.
2. **Railway's discovery document fails RFC 8414 issuer validation** — it is served from
   `/oauth/.well-known/openid-configuration` but declares `issuer` as the bare domain.
   Anything built on `openid-client`, Auth.js included, needs the endpoints pinned by
   hand (`src/lib/auth/oidc.ts`). The escape hatch is most of the implementation.
3. **v5 is still `5.0.0-beta.x`** and unproven against Next 16.

**What it costs, measured.** The auth implementation is **1,070 lines** across
`src/lib/auth/**` (708) and the three route handlers (362), 1,336 counting `src/proxy.ts` —
against **1,565 lines of tests**. (An earlier revision of this ADR said "about 150 lines"; that
was wrong by a factor of three, and a decision argued from a number should use the real
one.) In exchange for those lines, session encryption, CSRF and cookie chunking are
hand-rolled rather than inherited. Two consequences are listed under Limitations.

**Two scopes matter, not one.** Railway's prose scope table lists only `viewer` and
`member` for projects; `project:admin` appears in the live discovery document's
`scopes_supported`. `pnpm verify:schema` asserts it is still advertised.

`workspace:viewer` is the second, and it is not optional despite reading as though it
were. Railway scopes workspaces separately from projects, so a token holding
`project:admin` alone has `me.workspaces` refused outright — and because the app asked
for that field in the same document as the personal project list, the refusal used to
discard both. Every dashboard load failed with a reference id and nothing else. The
scope closes the gap; independent per-source documents make a future gap survivable.

**Consent is Railway's decision, not the app's.** `/api/auth/login` sends no `prompt`
parameter, so the consent screen appears on the first authorization — where no grant
exists yet — and is skipped afterwards. It previously sent `prompt=consent` on every
request, which is an override meaning "show it regardless": re-picking every shared
project was the price of each sign-in. `?consent=1` forces it, and only the explicit
"Authorize again" and "Choose projects" controls pass it. The one case a silent
authorization can fail is a provider that mints refresh tokens only alongside a
displayed consent screen; the callback detects a missing refresh token and retries once
with consent forced, guarded by a cookie so it cannot loop.

---

[All decisions](README.md) · [Railway Freight Loader](../../README.md)
