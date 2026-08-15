---
meta:
  updated: 2026-08-14
---

# Architecture

The reasoning behind each decision is argued at length in
[`docs/adr/`](../../docs/adr/README.md) (ADR-1 … ADR-14); the README carries a summary
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
- **Write** — `src/app/dashboard/actions.ts`, the only `"use server"` file in the repo, and
  the seven `action-*.ts` modules beside it. The directive file holds the ten exports and
  nothing else: each opens a request scope and hands off. What a verb does lives in
  `action-<verb>.ts`, and the shared parts in `action-form.ts` (fields, zod issues, thrown
  values) and `action-managed.ts` (the ownership guard). Actions return an `ActionResult`;
  they do not throw at the UI. See [errors-and-logging.md](errors-and-logging.md).

  The split is forced rather than chosen: a `"use server"` file may export only async
  functions, so a type, a constant or a synchronous helper cannot sit beside an action.
  Adding a verb means a module and one forwarder, never a tenth concern in the directive
  file.

- **Route handlers** — `src/app/api/**`. Two stream:
  `src/app/api/streams/[deploymentId]/route.ts` multiplexes deployment status and logs into
  a single SSE response, and `src/app/api/watch/[projectId]/route.ts` is the project
  watcher. SSE downstream, WebSocket upstream (ADR-3): the browser never opens a socket to
  Railway, because that would require the token in the browser. Two do not:
  `src/app/api/image-check/route.ts` answers a JSON enum member, and
  `src/app/api/service-variables/route.ts` answers the names of one service's variables so
  the edit dialog can draw its rows.

**A route handler is the right lane when the browser needs an answer mid-interaction, or
when the work needs the inbound `AbortSignal`.** The image check is both. A Server Action
would have worked and was rejected for two reasons: the write lane is where things that
change infrastructure live, so a read there makes it something other than what it says it
is — and actions are uncancellable, which is the wrong primitive for a
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

## `src/features/**` is decoration, and takes part in none of the above

`src/features/rail-yard/` is the canvas animation on the landing page. It is the largest
body of code outside `src/lib` — about nine thousand lines of simulation, geometry and
2D drawing — and it is worth saying plainly what it is, because its size otherwise invites
a reader looking for container logic to open it.

**It is in no lane.** One consumer, `src/app/page.tsx`, and no import anywhere under it of
`lib/railway/**`, `lib/auth/**`, `lib/logger`, `fetch` or `EventSource`. No Railway data
reaches it, no session touches it, it reads no application state and it renders nothing a
user acts on. Deleting it would change the landing page and nothing else.

Three consequences, each recorded where it applies rather than here:

- It **owns its own tuned numbers**, in `src/features/rail-yard/config.ts` — see the
  constants section below.
- It is **exempt from `@typescript-eslint/no-non-null-assertion`** in `eslint.config.mjs`,
  because nothing a caller supplied reaches the arrays it indexes.
- It is **not exempt from coverage**. It carries a directory floor like `lib` and `hooks`
  do ([testing.md](testing.md)); decorative is not the same as untested, and a large
  isolated module is exactly the kind that decays unobserved.

If anything under `features/` ever reads Railway data, the first two go with it.

## `src/proxy.ts` is Next 16's middleware, and it is where refresh lives

Server Components can read cookies but cannot write them, so a token that expires
mid-session cannot be repaired during render. The proxy runs before the render and _can_
write, so `refreshSession` runs there and sets the refreshed cookie on **both** the request
and the response — the render that triggered the refresh already sees the new token.

Two things in that file are load-bearing and easy to break:

- The forwarded header set must be built from `new Headers(request.headers)`. Next drops
  every request header absent from the override list.
- The matcher excludes `_next/static`, `_next/image`, `favicon.ico`, `icon.svg`,
  `api/auth` **and `api/health`**. Each matched request pays an HKDF derive and a JWE decrypt; a favicon is
  fetched on every cold tab. The auth routes are excluded because they mint the session and
  must not be gated by it. Static security headers still reach those paths — `next.config.ts`
  sets them on `/:path*` independently of this matcher.

A failed refresh is **not** proof the session is gone. Refresh tokens rotate, so a request
that lost a race spends a token another request already replaced.

`refreshSession` is what keeps that from signing anyone out, and it has two rules that a
change here must not break: **a fulfilled grant is retained for
`SESSION.REFRESH_GRACE_SECONDS` rather than deleted on settle**, and **a rejected one is
dropped immediately**. The race each of those answers — and the symptom that led to them —
is documented on `grants` in `src/lib/auth/refresh.ts`, which is where the mechanism lives.

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

That is six verbs now — destroy, stop, restart, redeploy, rollback, edit — and they share **one** guard:
`withManagedContainer` in `src/app/dashboard/action-managed.ts` parses the three ids,
re-reads the container list from Railway, and refuses before the verb's own callback runs. A second copy
of that check is the thing to refuse in review, because the weaker copy is the one that
would ship. Two lint rules assert the shape structurally, and neither is sufficient alone:
`no-restricted-imports` lets only `src/app/dashboard/**` import a mutation from
`lib/railway/api`, and `local/mutation-inside-ownership-guard` requires each call to sit
inside `withManagedContainer`'s callback. The first alone would let the write lane act on
an unchecked id; the second alone would let any module act as long as it opened a guard.

The batch is the one shape that satisfies neither by containment, and it is allowed for a
stronger reason than position. `destroyMany` reads the container list once and calls
`resolveManagedTarget` per id, so what refuses a forged id is the type: `ManagedResolution`
is a discriminated union, and `.target` does not exist on the branch where `managed` is
false. The rule recognises a function that calls a resolver as having done the check.

**The deployment id is derived, never posted.** A lifecycle action reads it off the
container it just re-derived ownership from, so a forged deployment id is refused by the
same mechanism a forged service id is. **So is the volume id**: destroy posts a boolean
(`deleteData`) and reads the volume back from Railway inside the action.

**Rollback is the single exception, and it names its own condition.** A rollback target is a
deployment in the _past_, so there is no current field to derive it from and the browser is
the only thing that knows which entry was clicked — the id travels on the form. What replaces
the derivation is the shape destroy already uses for the volume: inside the guard's callback,
`rollback` in `action-deploy.ts` re-reads the service's deployment list — scoped by the
serviceId on the resolved `target`, which is Railway's answer rather than the form's — and
refuses any id that is not a member of it with `canRollback` set. The list read is degrading,
so a refusal yields an empty list and refuses too; **the only direction this may fail in is
closed.** Being inside the guard is necessary and not sufficient here, which is why
`local/mutation-inside-ownership-guard` listing `rollbackDeployment` does not discharge the
obligation — no rule can see the membership check, and its docblock is where it is written
down. Do not read this as permission to accept a deployment id anywhere else: a new verb that
wants one has to make the same argument in full.

**A volume's owner is the service it is mounted on, not its own name.** This app creates a
volume only as a step of creating a service, and the prefix check above has already proved
that service is ours before `deleteVolume` is reachable — so there is no second marker to
check. Railway names a volume after its service anyway (`spun-pg` → `spun-pg-volume`), which
is why `volumeUpdate` is in `OPTIONAL_FIELDS` rather than being a document. Destroy asks
whether the data goes too, defaults to yes, and **names the outcome on both branches** — a
kept volume is billable storage this UI can no longer show, so it must not be left unsaid.
[ADR-14](../../docs/adr/0014-a-volume-belongs-to-the-service-that-mounts-it.md) has the rest,
including why every way of failing to see a volume ends in keeping it.

**A rename cannot escape the prefix, and needs no rule saying so.** The edit verb puts what
was submitted through `toManagedName` — the same function spin-up uses — which always
prefixes. So there is nothing to validate and nothing to refuse: a name that has lost
`MANAGED_PREFIX` is not a request shape. Note the direction it runs in: the form posts the
_display_ name, which is `stripPrefix`'d, so passing it `rawName` would prefix twice.

**The prior variable set is derived too, for the same reason.** The edit form posts the rows
it wants to end up with and says nothing about what was there before; the action reads that
from Railway. A client that could name the prior set could name one that included a variable
it wanted deleted.

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
string; pending state comes from `useTransition` and `router.refresh()`. Not `useFormStatus`:
it reports a form React is submitting, and no form here hands React its action — see
`local/no-function-form-action` for what that prop costs.
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

  **It has been run, and these are settled — do not spend a live session re-asking them.**
  `metrics` and the workspace chain are both readable on a `project:admin` +
  `workspace:viewer` session. `CPU_USAGE` is populated and `CPU_USAGE_2` answers with an
  empty array. `CPU_LIMIT` and `MEMORY_LIMIT_GB` are populated per service, in the same
  request, which is what each row's denominator is built on. `sampleRateSeconds: 60` over a
  five-minute window returns exactly five points per series. `estimatedUsage` returns
  magnitudes, not money. Railway adds one aggregate result per measurement with
  `tags.serviceId: null`, which `toContainerMetrics` drops.

  **Still open:** whether passing `environmentId` alongside `projectId` narrows the result.
  The probe project has services in one environment only, so both shapes returned the same
  rows and proved nothing. A project with two populated environments would settle it.

- `pnpm probe:deployment <deploymentId>` — prints a failed deployment's events verbatim and
  what `pickFailureReason` chose from them, which is the only way to check the order in
  `failure-reason.ts` against a real failure.
- `pnpm probe:deployments <projectId> <environmentId> <serviceId>` — what a delegated grant
  actually gets from `Query.deployments`, which the rollback control rests on. Three
  questions introspection cannot answer: whether an OAuth session may call the field at all,
  which order the edges arrive in, and what `canRollback` says about a running deployment
  versus a finished one. The ordering is the one with teeth — `DEPLOYMENTS_QUERY` asks for
  `last: N` on the strength of the single observation in `DEPLOYMENT_EVENTS_QUERY`, and if
  deployments arrive newest-first instead it silently offers the ten oldest.

  **Still open, and deliberately unanswerable here:** whether `deploymentRollback` reuses a
  deployment id or mints a new one. It returns a Boolean, so observing it would mean
  performing a real rollback — and these are all read-only. Nothing depends on the answer;
  the row re-keys its stream on whatever the refreshed list reports, as it does after a
  redeploy.

- `pnpm probe:logs <deploymentId> [--phase build]` — settles what the two log feeds
  actually return: whether a line carries an id, whether `limit` means the most recent N,
  and how far back a subscription replays. `src/lib/log-overlap.ts` is built on the
  answers, and the e2e fake decides all of them by fiat.
- `pnpm probe:subscription [deploymentId]` — whether Railway lets a client subscribe to
  deployment status. It carries its own control: it subscribes to a field that does not
  exist first, and refuses to conclude anything unless the server rejects that one by name.
  This is the probe that found three ADRs and a constant asserting a subscription does not
  exist when it does.

  **All five prefer `RC_SESSION` over `RAILWAY_TOKEN`, and the difference is the point.**
  An account token has wider visibility than a delegated OAuth grant — it is refused
  `me { projects }` outright — so it can establish that a capability exists and never that
  this app could use it. Sign in locally and copy the `rc_session` cookie.

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
`IDEMPOTENCY`, `LIMITS`, `UI`, `LIST`, `LINKS`, `REGISTRY`, `REGIONS`),
each with a comment saying why the value is what it is. These were scattered as inline
literals across the client, the stream route, the session layer and three components, and
the log backfill limit had already drifted from its default.

A new timeout, retry count, buffer size or ceiling goes there, in its group, with a
rationale. Do not inline it "just this once".

**Two exclusions, and they are the whole list.** `WATCH_POLL_MS` and `METRICS_POLL_MS` are
in `src/env.ts`, because the right value for each depends on the rate limit of the plan
behind the token; `src/lib/constants.ts` says so at the `WATCH` and `METRICS` groups.

And **`src/features/**` owns its own** — `src/features/rail-yard/config.ts` holds roughly
ninety. That is the right home rather than a violation, for the reason the decoration
section above gives: no application data reaches the rail yard, and its timestep and track
geometry are not part of this app's tuning surface. The test is what the number
affects, not where it is declared: anything a Railway request, a session or a rendered
container depends on goes in `constants.ts`, and a number that only moves a pixel does not.

## Configuration goes through `src/env.ts`

zod schema, memoised, `__resetEnv()` for tests. Required: `RAILWAY_CLIENT_ID`,
`RAILWAY_CLIENT_SECRET`, `SESSION_SECRET` (≥32 chars). Optional: `APP_URL`,
`APP_ORIGINS`, `MANAGED_PREFIX`, `WATCH_POLL_MS`, `METRICS_POLL_MS`, `REGISTRY_PROBE_URL`,
and the three `RAILWAY_*` endpoint overrides that exist so the e2e suite can point the whole app at
`e2e/fixtures/fake-railway`.

**The origin must be https unless it is loopback**, because every cookie decision reads it
— `secure` is derived from it, and so is whether the session cookie carries the `__Host-`
prefix. An origin that says http silently downgrades the session to a cleartext,
unprefixed cookie. That rule now applies to the origin derived from each request, not to a
variable; see the next section.

A new variable means: a field on the schema **and** an entry in `.env.example`. Nothing
else — the parse input is derived from `schema.shape`, so every field is read from the
environment variable of its own name by construction.

It is derived because the hand-written literal it replaced drifted: `WATCH_POLL_MS` was
declared in the schema and omitted from that literal for its whole life, and since it
carries a default nothing failed. `env()` returned 15000 while `playwright.config.ts`,
`scripts/serve-e2e.ts` and any deployment that set it were all ignored. **Do not reintroduce
the literal.** `APP_URL` is the single explicit override, because with it unset the value
falls back to `RAILWAY_PUBLIC_DOMAIN` rather than to a variable of its own name.

Give every optional field an override assertion in `src/env.test.ts`, not just a default
assertion. A default test cannot tell a forwarded field from an ignored one — that is
exactly how the above went unnoticed.

`LOG_LEVEL` is the single deliberate exception and reads `process.env` directly — see
[errors-and-logging.md](errors-and-logging.md) for why.

## The origin is the request, not a variable

`src/lib/origin.ts` derives the origin this app is being reached at from the request's own
headers — `x-forwarded-host` else `host`, scheme from `x-forwarded-proto` — validates it,
and returns a branded `AppOrigin` that nothing else can mint. `APP_URL` is the fallback for
a request carrying no usable Host, and `APP_ORIGINS` is an optional allowlist. ADR-13 has
the reasoning; these are the obligations.

**Three contexts read it, and each has its own way in.** `src/proxy.ts` calls
`resolveOrigin` with `request.headers`; the three auth routes call `requestOrigin` from
`lib/auth/request-origin.ts`, which also owns the refusal log and the 400; Server
Components go through `lib/auth/server.ts`, which reads `headers()` from `next/headers`.

**There is deliberately no `x-app-origin` header.** The proxy stamps the CSP nonce and
`x-request-id` because it _mints_ them and they have no other channel. The origin is a pure
function of headers the render already receives, so a stamped header would be a second
source of truth that the proxy-excluded paths (`api/auth/*`, `api/health`) would not have,
plus one more client-supplied header to remember to overwrite. Re-derive on both sides.

**`src/lib/origin.ts` must never import `server-only` or `next/headers`,** because
`src/proxy.ts` imports it, and must never import `@/env`, because `src/env.ts` imports
`isSecureOrLocal` back out of it. Configuration reaches it as a parameter.

**A route handler may name neither `request.url` nor `APP_URL`.** Behind Railway's proxy
the first is the container's own address, and the second is one configured domain rather
than the one this request arrived at. Both are `no-restricted-syntax` selectors in
`eslint.config.mjs` scoped to `src/app/**/route.ts`, and each message explains what the
mistake looked like in production.

**A refusal never logs the host it refused.** It is caller input, so the record carries a
bounded reason (`absent`, `unparseable`, `insecure`, `not_allowlisted`); the configured
allowlist goes on the `boot` line instead, which is where the answerable half lives.

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
