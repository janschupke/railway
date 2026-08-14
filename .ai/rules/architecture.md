---
meta:
  updated: 2026-08-14
---

# Architecture

The reasoning behind each decision is argued at length in
[`docs/adr/`](../../docs/adr/README.md) (ADR-1 … ADR-11); the README carries a summary
table under `## Decisions`. This file states what the decisions oblige you to do. When
the two disagree, the ADR is the record and this file is stale — fix it.

## What the app is

One Next.js 16 App Router application. A visitor signs into **their own** Railway account
over OIDC, picks or creates a project and environment, and creates, stops, restarts,
redeploys and destroys Docker-image services with live build and deploy logs streamed into
the browser.

Single package — not a monorepo. `pnpm-workspace.yaml` exists only to carry `allowBuilds`
toggles; there is no `packages:` list. That is not a reason to move to npm: `allowBuilds` is
a per-package postinstall allowlist with no npm equivalent, and therefore a supply-chain
control rather than an install-speed tweak. See
[ADR-11](../../docs/adr/0011-pnpm-stays.md), which prices the migration rather than
assuming either answer. pnpm 11.9.0, Node 22,
React 19.2.8, Next 16.3.0.

`@/*` resolves to `src/*` (`tsconfig.json`, mirrored in `vitest.config.mts`). Use it for
anything cross-directory; use relative `./` only for siblings, which in practice means
inside `src/components`.

## Server Components read, Server Actions write, route handlers do the rest

Three lanes, and a change belongs in exactly one of them.

- **Read** — `src/app/dashboard/data.ts`. Called from Server Components. Never from a
  client component.
- **Write** — `src/app/dashboard/actions.ts`. The only `"use server"` file in the repo.
  Actions return an `ActionResult`; they do not throw at the UI. See
  [errors-and-logging.md](errors-and-logging.md).
- **Route handlers** — `src/app/api/**`. Two stream:
  `src/app/api/streams/[deploymentId]/route.ts` multiplexes deployment status and logs into
  a single SSE response, and `src/app/api/watch/[projectId]/route.ts` is the project
  watcher. SSE downstream, WebSocket upstream (ADR-3): the browser never opens a socket to
  Railway, because that would require the token in the browser. One does not:
  `src/app/api/image-check/route.ts` answers a JSON enum member.

**A route handler is the right lane when the browser needs an answer mid-interaction, or
when the work needs the inbound `AbortSignal`.** The image check is both. A Server Action
would have worked and was rejected for two reasons: `actions.ts` is documented as the only
`"use server"` file _and_ as the write lane, so a read there makes the file something other
than what it says it is — and actions are uncancellable, which is the wrong primitive for a
request the next keystroke should abort. Do not read this as permission for a REST API;
the read lane is still where reads belong, and this is the exception that names its own
conditions.

`"use client"` is a bundle decision as much as an interactivity one — see
[performance.md](performance.md). Default to a Server Component.

**Only the stream lane can be cancelled by the client.** Next 16 exposes the inbound
request's `AbortSignal` on `NextRequest` and nowhere else, so a route handler can thread
`request.signal` into the Railway client and a data loader or Server Action cannot — there
is no accessor for it in a Server Component, and the signals inside app-render are the
prerender and cache ones, which say nothing about the client hanging up. A read on the
first two lanes therefore runs to completion after the user has navigated away, bounded
only by `NETWORK.MAX_ATTEMPTS × REQUEST_TIMEOUT_MS`. Do not close that gap with a
synthetic deadline: it cannot tell an abandoned render from a slow one, so it bounds the
first by failing the second. The retry backoff _is_ cancellable — `backoff` in
`src/lib/railway/client.ts` — which is what the callers holding a real signal needed.

## `src/proxy.ts` is Next 16's middleware, and it is where refresh lives

Server Components can read cookies but cannot write them, so a token that expires
mid-session cannot be repaired during render. The proxy runs before the render and _can_
write, so `refreshSession` runs there and sets the refreshed cookie on **both** the request
and the response — the render that triggered the refresh already sees the new token.

Two things in that file are load-bearing and easy to break:

- The forwarded header set must be built from `new Headers(request.headers)`. Next drops
  every request header absent from the override list.
- The matcher excludes `_next/static`, `_next/image`, `favicon.ico`, `icon.svg` and
  `api/auth`. Each matched request pays an HKDF derive and a JWE decrypt; a favicon is
  fetched on every cold tab. The auth routes are excluded because they mint the session and
  must not be gated by it. Static security headers still reach those paths — `next.config.ts`
  sets them on `/:path*` independently of this matcher.

A failed refresh is **not** proof the session is gone. Refresh tokens rotate, so a request
that lost a race spends a token another request already replaced.

`refreshSession` is what keeps that from signing anyone out. It holds one grant per token
being spent, and **retains a fulfilled grant for `SESSION.REFRESH_GRACE_SECONDS` rather
than deleting it on settle** — a request already in flight with the old cookie arrives
after the winner resolved, and must be handed the live session instead of spending a dead
token. Deleting on settle deduped only strictly overlapping callers, which is half the
race. A _rejected_ grant is dropped immediately; caching one turns an upstream blip into a
sign-out for the whole window.

The re-read in the proxy's catch block stays, but know what it is: `request.cookies` is
that invocation's own inbound jar, so the only thing that can put a newer session in it is
the success branch above. It covers one request refreshing itself, not two requests
racing. Do not relabel it as the cross-request guard, and do not delete the cookie ahead
of it.

**The proxy is the only refresh writer.** `requireSession` in `src/lib/auth/server.ts`
reads and refuses; it does not refresh. Its callers all sit on paths the matcher covers,
so the proxy has already refreshed and written the cookie onto the request before their
handler runs — and a refresh from that side would use a _different copy_ of the grant map,
because `src/proxy.ts` compiles into its own chunk graph (see the boundary note below).
Two copies means the same token spent twice, which is the failure the map exists to
prevent.

## The app only ever acts on services it created

Railway services carry no arbitrary metadata, so the **name prefix is the ownership
marker** — `MANAGED_PREFIX`, default `spun-`, in `src/lib/railway/managed.ts`. Every path
that changes a container that already exists goes through `isManagedName`. A user could
forge the prefix by renaming a service in Railway's own dashboard; that is an accepted
trade, because the blast radius is bounded by the OAuth scopes they granted and the prefix
is visible in Railway's UI rather than hidden metadata.

That is four verbs now — destroy, stop, restart, redeploy — and they share **one** guard:
`withManagedContainer` in `src/app/dashboard/actions.ts` parses the three ids, re-reads the
container list from Railway, and refuses before the verb's own callback runs. A second copy
of that check is the thing to refuse in review, because the weaker copy is the one that
would ship. `src/lib/railway/mutation-callsites.test.ts` asserts the shape structurally:
each mutation is reachable from that file and nowhere else, `!target.managed` appears in it
exactly once, and every mutation call sits below it.

**The deployment id is derived, never posted.** A lifecycle action reads it off the
container it just re-derived ownership from, so a forged deployment id is refused by the
same mechanism a forged service id is.

**Changing `MANAGED_PREFIX` after containers exist orphans them.** They stay in Railway and
become read-only in this app. Say so if you ever propose changing it.

**Projects and environments are created but never destroyed, and so carry no marker.** The
prefix exists to gate destroy; `projectDelete` and `environmentDelete` are deliberately
absent from `operations.ts` entirely, which is a stronger guarantee than a guarded call
site. Prefixing them would put `spun-` on a name the user typed and reads back in Railway's
own dashboard, in exchange for guarding nothing. Deleting a project takes every service,
environment and volume in it, including the ones this app did not create — if you ever
propose adding it, that is the sentence to start from.

## The URL is the state; there is no client store

No Redux, no Zustand, no context holding server data (ADR-7). Selection lives in the query
string; pending state comes from `useTransition`, `useFormStatus` and `router.refresh()`.
`src/hooks/use-navigation-pending.ts` covers full document navigations and is bfcache-safe
via `pageshow`.

If a change seems to need a store, it usually needs a search param.

## No database

Nothing is persisted (ADR-4). No ORM, no migrations, no seed data, no generated client. The
only server-held state is the session cookie itself, which is sealed and lives in the
browser. Do not introduce persistence to solve a caching problem.

## The GraphQL client is hand-rolled, on purpose

`src/lib/railway/client.ts` (transport, retry, timeout) and `src/lib/railway/operations.ts`
(the documents). Not Apollo (ADR-8). `src/lib/railway/subscribe.ts` speaks `graphql-ws`
upstream; `mappers.ts` turns Railway's shapes into `src/lib/railway/types.ts`.

**The documents carry their own types, and nothing else may claim them.** Each export in
`operations.ts` is annotated `TypedDocument<Result, Variables>` from
`graphql.generated.ts`, and `gql`/`gqlPartial` read both off the document — so a call site
passes no type argument and its variables are checked. Writing a result shape by hand is
the thing T-476 removed: it was an assertion nothing verified. A new document means a new
entry in `operations.ts`, `pnpm codegen`, and nothing else.

Scripts exist so you do not have to reason about Railway's schema from memory:

- `pnpm probe:projects` — prints what each project source actually returns for a real
  session. Run it **before** editing the project queries.
- `pnpm probe:metrics <projectId> <environmentId>` — prints what `metrics`,
  `estimatedUsage` and the `project.workspace.customer` chain answer for a real OAuth
  session. Introspection says what the schema declares; only this says what the token is
  permitted to read, which is a different question and the one the readouts depend on.
- `pnpm schema:pull` — dumps Railway's schema from live introspection into
  `src/lib/railway/schema.graphql`, which is **committed**. Needs `RAILWAY_TOKEN`.
- `pnpm codegen` — generates `src/lib/railway/graphql.generated.ts` from that artifact and
  the documents in `operations.ts`, validating each one on the way. Needs no token, which is
  what lets `pnpm codegen:check` gate CI: regeneration must be a no-op.
- `pnpm verify:schema` — validates every document against the committed schema (no token),
  then against the **live** schema and diffs the two over the surface the documents reach
  (with `RAILWAY_TOKEN`). It also prints the optional capabilities, the probed input shapes
  and any deprecated field the app selects. There is no hand-maintained field list any more;
  the only declarations left in `operations.ts` are `DEGRADING_OPERATIONS` and
  `OPTIONAL_FIELDS`, which are product decisions rather than derivable facts. CI holds no
  token, so the live comparison is local-only — a Railway-side change can pass CI and fail
  here.

## Import boundaries are enforced from the client side

`src/components/**` and `src/hooks/**` may not import:

- `lib/auth/session`, `lib/auth/refresh`, `lib/auth/server` — they hold the JWE seal/open
  code, the HKDF derivation and the shape of `RailwaySession`.
- `lib/logger`, `lib/log/*` — the logger writes to the server's stdout, which a browser does
  not have. A client component importing it bundles pino and logs into a void.

`import "server-only"` is the usual guard and is **deliberately not** on those auth modules:
its exports map resolves to a bare `throw` outside the `react-server` condition, and two
legitimate callers resolve it that way — `src/proxy.ts` (middleware layer) and
`scripts/probe-projects.ts` (plain tsx). The modules that _do_ carry `server-only` are
exactly the ones the proxy does not import. That is the constraint, not an oversight, and
the eslint rule in `eslint.config.mjs` is the enforcement.

If a component needs something from the session, **pass it as a prop**.

## Module state does not cross the proxy/render boundary

A module imported by both `src/proxy.ts` and the app is **two instances**, not one. Next
compiles the proxy into `.next/server/middleware.js` with its own chunk graph and says so
outright: the proxy is invoked separately from the render and in optimized cases deployed
to a CDN, so do not rely on shared modules or globals across it.

Everything that has to pass between the two goes through headers instead — the CSP nonce,
and `x-request-id` in `src/lib/log/request-scope.ts`. There is nowhere else to put it:
this app has no database, no Redis, no KV.

So a module-level `Map` — `inFlight`/`grants` in `lib/auth/refresh.ts`, `derivedKeys` in
`lib/auth/session.ts`, `entries` in `lib/idempotency.ts` — is per bundle. `derivedKeys` does
not care; deriving the same key twice is a wasted HKDF and nothing more. A refresh dedupe
map very much does, which is why only the proxy refreshes. `entries` is single-flight and
would be worthless split in two — the proxy does not import it, and it must not start.
**Before adding process-global state to a module the proxy imports, work out what happens
when the app bundle has its own copy.**

## Every tuned number lives in `src/lib/constants.ts`

Grouped by the concern that owns it (`NETWORK`, `STREAM`, `WATCH`, `METRICS`, `SESSION`,
`IDEMPOTENCY`, `LIMITS`, `UI`, `LIST`, `LINKS`),
each with a comment saying why the value is what it is. These were scattered as inline
literals across the client, the stream route, the session layer and three components, and
the log backfill limit had already drifted from its default.

A new timeout, retry count, buffer size or ceiling goes there, in its group, with a
rationale. Do not inline it "just this once".

The two numbers that are not there are the watcher's poll interval and the usage-readout
staleness window — `WATCH_POLL_MS` and `METRICS_POLL_MS` in `src/env.ts`, because the right
value for each depends on the rate limit of the plan behind the token. `src/lib/constants.ts`
says so at the `WATCH` and `METRICS` groups.

## Configuration goes through `src/env.ts`

zod schema, memoised, `__resetEnv()` for tests. Required: `RAILWAY_CLIENT_ID`,
`RAILWAY_CLIENT_SECRET`, `SESSION_SECRET` (≥32 chars), `APP_URL`. Optional with defaults:
`MANAGED_PREFIX`, `WATCH_POLL_MS`, `METRICS_POLL_MS`, and the three `RAILWAY_*` endpoint
overrides that exist
so the e2e suite can point the whole app at `e2e/fixtures/fake-railway`.

`APP_URL` must be https unless it is loopback, because **every cookie decision reads it** —
`secure` is derived from it, and so is whether the session cookie carries the `__Host-`
prefix. An `APP_URL` that says http silently downgrades the session to a cleartext,
unprefixed cookie.

A new variable means: a field on the schema **and** an entry in `.env.example`. Nothing
else — the parse input is derived from `schema.shape`, so every field is read from the
environment variable of its own name by construction.

It is derived because the hand-written literal it replaced drifted: `WATCH_POLL_MS` was
declared in the schema and omitted from that literal for its whole life, and since it
carries a default nothing failed. `env()` returned 15000 while `playwright.config.ts`,
`scripts/serve-e2e.ts` and any deployment that set it were all ignored. **Do not reintroduce
the literal.** `APP_URL` is the single explicit override, because in production its value
comes from `RAILWAY_PUBLIC_DOMAIN` rather than a variable of its own name.

Give every optional field an override assertion in `src/env.test.ts`, not just a default
assertion. A default test cannot tell a forwarded field from an ignored one — that is
exactly how the above went unnoticed.

`LOG_LEVEL` is the single deliberate exception and reads `process.env` directly — see
[errors-and-logging.md](errors-and-logging.md) for why.

## Conventions

- **File names are kebab-case**, everywhere: `container-row.tsx`, `deployment-monitor.ts`,
  `use-project-watcher.ts`.
- **Named exports**, PascalCase for components (`export function ContainerRow`). Default
  exports only where the App Router requires them (`page.tsx`, `layout.tsx`, `route.ts`,
  `error.tsx`, `loading.tsx`, `not-found.tsx`).
- **Import order**: React → `next` → third-party → `@/…` → relative.
- **Props** are an inline object type in the signature; primitives extend
  `React.ComponentProps<"button"> & VariantProps<typeof …>`.
- **Comments explain why, not what.** This codebase records what broke before, which
  alternative was rejected, and what a number was measured against. Match that register —
  a comment that restates the line below it is noise here.
- `src/instrumentation.ts` is the OTel seam (ADR-9). It is not unused: it exports
  `onRequestError`, which Next calls on every server render failure and which records the
  `digest` the error boundary shows the user. Only `register()` is unimplemented. Shipping
  logs somewhere should change that file and nothing else in `src/**`.

## Before you call this done

```sh
pnpm check
```

If you edited `src/lib/railway/operations.ts` or `src/lib/auth/oidc-metadata.ts`, also:

```sh
pnpm codegen        # a document's types; `pnpm check` fails if this was not run
pnpm verify:schema
```

`pnpm codegen` validates against the committed schema, so it is only as current as the last
`pnpm schema:pull`. If a document is failing for a reason Railway's own docs contradict,
refresh the artifact — with a token — before believing the error.
