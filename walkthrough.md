# Walkthrough

A guided tour of Railway Freight Loader: what it does, where its code is, and why it is shaped
the way it is. Start here; [README.md](README.md) is for running and deploying it.

**Live: <https://trains.schupke.io>**

---

## What it is

A browser tool for spinning Docker-image containers up and down inside **your own** Railway
projects. You sign in with a Railway account over OIDC, Railway's own consent screen decides
which projects are shared, and every mutation afterwards carries your token. The app holds no
Railway API credential of its own — only its OAuth client secret, which authenticates it to
Railway's token endpoint and reaches no project — so it acts on nothing you have not granted.

One Next.js 16 App Router process, single package, no database, no client store. The access
token never leaves the server in plaintext — it rides to the browser only as ciphertext inside
the encrypted session cookie.

---

## What it does

**Signing in.** OIDC with PKCE `S256` straight against Railway, with no auth vendor in between.
Railway's consent screen appears on every sign-in, because Railway issues a refresh token only
for a request carrying both `offline_access` and `prompt=consent`, and a session without one
dies an hour in. **Authorize again** and **Re-authorize** are the two controls that send you
back to it deliberately, when Railway withheld a scope. Sign-out clears the session here and
nothing at Railway; the notice says so and links to the account settings page where the
authorization is removed.

**Projects and environments.** Pick either; both live in the URL, so the view is linkable and
survives a reload. You can create a project and create an environment. Neither can be deleted
here — deleting a project takes every service, environment and volume inside it, including the
ones this app did not create, so no request shape reaches those mutations
([Limitations](docs/limitations.md#projects-environments-and-volumes)).

**Spinning up.** Choose from a twelve-image preset catalog — redis, memcached, nginx, apache,
caddy, whoami, postgres, mysql, mariadb, mongo, rabbitmq, nats — or type any image reference.
Behind an Advanced disclosure: region, replicas, vCPU, memory, restart policy, restart retries
and start command. Plus an environment-variable editor with generated or typed passwords, an
advisory image-existence check against Docker Hub / ghcr.io / quay.io as you type, an optional
public address, and a volume attached automatically to the six presets that keep state. Every
submission carries an idempotency key, so a double-click yields one container.

**Six lifecycle verbs** — stop, restart, redeploy, rollback, edit and destroy — every one of them
gated by the `spun-` ownership marker, re-derived on the server from Railway's own answer. Every
row carries one **…** menu holding whatever that row may do; rollback stays in the expanded
history panel, where it belongs to a deployment rather than to the container. Destroy asks you to
type the container name and asks whether the volume's data goes too. Bulk destroy asks for the
count rather than each name. Rollback lists recent deployments by time and status and marks the
current one. Containers created outside the app get the same menu with two commands — look at it,
or open it on Railway — and no checkbox.

**Watching it happen.** Live build and deploy logs stream into an expandable row panel — SSE
downstream, GraphQL-ws upstream — with search and match highlighting, next/previous, a wrap
toggle, copy, download and a severity filter. The status badge advances Queued → Building →
Deploying → Running, or settles at Failed or Removed; Sleeping, Removing and Unknown are the
three further states it can carry. Each row reads CPU and memory against the plan ceiling
("0.25 of 2 vCPU") and a derived uptime. The count above the list carries a tooltip with two
totals — what the containers created here are using, and what everything in the environment is —
and the **Billing** tab, one of the dashboard's three, holds the workspace spend beside them. A
failed row carries a best-effort reason and **Open in Railway**.

**Noticing changes you did not make.** A container created or destroyed in Railway's own dashboard
appears here within about fifteen seconds, with no polling from the browser at all — and none from
anywhere while the tab is hidden.

**Finding things.** Search, status filter, owner filter and sort are all URL params applied
client-side, with **Clear filters** and incremental paging. Managed containers sort first by
default.

**The chrome.** Dark by default, light following `prefers-color-scheme`, an explicit toggle
beating both. Announced toasts, focus traps, focus restore, full keyboard operation, WCAG 2.1 AA.
One locale, fully externalised. And an animated freight rail yard behind the sign-in card, which
freezes to a deterministic still frame under `prefers-reduced-motion` —
[and is not part of the app](#the-rail-yard-is-decoration).

---

## How a request flows

```
Browser ──── SSE ─────► Next.js (single Railway service)
   ▲     └── fetch ────►    │
   │                        ├── HTTPS  ─► backboard.railway.com/graphql/v2   (mutations, queries)
   │                        └── WSS    ─► backboard.railway.com/graphql/v2   (log subscriptions)
   │
   └── Server Components render the container list; Server Actions mutate.
       The Railway access token never leaves the server.
```

One process, one deployment, and four lanes that do not cross:

1. **[src/proxy.ts](src/proxy.ts)** runs before every render. It refreshes the Railway access
   token when it is close to expiring and writes the new cookie onto the request as well as the
   response, so the render that triggered the refresh already sees the fresh token
   ([ADR-2](docs/adr/0002-token-refresh-runs-in-the-proxy-layer.md)).
2. **Server Components read.** The dashboard route is `force-dynamic`, declared once on
   [src/app/dashboard/layout.tsx](src/app/dashboard/layout.tsx) so all three views agree.
   [page.tsx](src/app/dashboard/page.tsx) awaits only the shell and hands the container list to
   a keyed Suspense boundary that awaits its own Railway round trip.
3. **Server Actions write.** [src/app/dashboard/actions.ts](src/app/dashboard/actions.ts) is the
   only `"use server"` file in the repo; it is a thin surface of eleven exports over sibling
   `action-*.ts` implementations.
4. **Two SSE routes push.** `/api/streams/[deploymentId]` multiplexes deployment status and log
   output into an open tab; `/api/watch/[projectId]` pushes a single bit when the project has
   moved ([ADR-10](docs/adr/0010-the-dashboard-watches.md)).

Three route handlers answer a browser `fetch` as well — `/api/service-variables`,
`/api/service-deployments` and `/api/image-check` — each for a read a client component performs
mid-interaction, where a route handler is the only lane that gets the inbound `AbortSignal`.
None of them holds state afterwards: the answer is rendered and discarded. That is why there is
no client cache to reconcile and no store to hold one
([ADR-7](docs/adr/0007-the-url-is-the-state.md)).

---

## Where the code is

| Path                                                                           | Role                                                                         |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| [src/proxy.ts](src/proxy.ts)                                                   | Next 16's middleware. Refreshes the access token before the render           |
| [src/env.ts](src/env.ts)                                                       | Every environment variable, validated once, with `LOG_LEVEL` the exception   |
| [src/app/page.tsx](src/app/page.tsx)                                           | Landing and sign-in; redirects to `/dashboard` when a session exists         |
| [src/app/dashboard/page.tsx](src/app/dashboard/page.tsx)                       | The dashboard route: shell, then a keyed Suspense over the container list    |
| [src/app/dashboard/data-shell.ts](src/app/dashboard/data-shell.ts)             | The read path, part one — identity, projects, the resolved selection         |
| [src/app/dashboard/data-containers.ts](src/app/dashboard/data-containers.ts)   | The read path, part two — containers, metrics, volumes                       |
| [src/app/dashboard/actions.ts](src/app/dashboard/actions.ts)                   | The only `"use server"` file; eleven exports over the `action-*.ts` files    |
| [src/app/dashboard/action-spin-up.ts](src/app/dashboard/action-spin-up.ts)     | Create: idempotency key, variables, volume, size, region, domain             |
| [src/app/dashboard/action-destroy.ts](src/app/dashboard/action-destroy.ts)     | Destroy, single and batch, and the volume decision                           |
| [src/app/dashboard/action-managed.ts](src/app/dashboard/action-managed.ts)     | The ownership guard every mutating verb runs inside, and its log records     |
| [src/app/dashboard/action-deploy.ts](src/app/dashboard/action-deploy.ts)       | Stop, restart, redeploy, rollback and the public address, inside that guard  |
| [src/lib/auth/](src/lib/auth/)                                                 | OIDC flow, encrypted session cookie, refresh rotation                        |
| [src/lib/origin.ts](src/lib/origin.ts)                                         | The served origin, derived per request from the forwarded host and validated |
| [src/lib/railway/](src/lib/railway/)                                           | GraphQL client, documents, mappers, status model, ownership marker           |
| [src/lib/railway/operations.ts](src/lib/railway/operations.ts)                 | Every GraphQL document, each annotated `TypedDocument<Result, Variables>`    |
| [src/lib/railway/deployment-monitor.ts](src/lib/railway/deployment-monitor.ts) | Merges the status poll and the log subscription into one stream              |
| [src/lib/railway/managed.ts](src/lib/railway/managed.ts)                       | The `spun-` prefix: the whole of the ownership claim                         |
| [src/lib/sse.ts](src/lib/sse.ts)                                               | SSE transport: framing, keepalive, duration ceiling                          |
| [src/lib/presets.ts](src/lib/presets.ts)                                       | The twelve-image catalog, its variables, ports and mount paths               |
| [src/lib/constants.ts](src/lib/constants.ts)                                   | Every tuned number, grouped by the concern that owns it                      |
| [src/lib/logger.ts](src/lib/logger.ts)                                         | Structured logs: request-scoped fields, the error serializer                 |
| [src/app/tokens.css](src/app/tokens.css)                                       | Design tokens — primitives, then the semantic layer the UI uses              |
| [src/components/ui/](src/components/ui/)                                       | Primitives on Radix; feature components never hand-write a colour            |
| [src/components/container-row.tsx](src/components/container-row.tsx)           | One row: badge, readouts, controls, and the log panel's disclosure           |
| [eslint-rules/](eslint-rules/)                                                 | The lint rules this repo needed and no linter ships                          |
| [e2e/fixtures/fake-railway/](e2e/fixtures/fake-railway/)                       | Stand-in Railway: OIDC + GraphQL + graphql-ws, with fault injection          |
| [scripts/verify-schema.ts](scripts/verify-schema.ts)                           | Validates every document against the committed schema; live too with a token |

---

## The decisions

Fourteen, argued in full in [`docs/adr/`](docs/adr/README.md). The short version of each:

| #                                                                         | Decision                                                                  | Why it matters                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [ADR-1](docs/adr/0001-railway-oidc-directly-not-an-auth-vendor.md)        | Railway OIDC directly, not an auth vendor                                 | The app acts on **the visitor's** Railway account, not on a token I own — that makes auth a capability-delegation problem, not a login problem, and Railway is itself a compliant OIDC provider                                                         |
| [ADR-2](docs/adr/0002-token-refresh-runs-in-the-proxy-layer.md)           | Token refresh runs in the proxy layer                                     | Access tokens live one hour and refresh tokens rotate on every use; Server Components can read cookies but not write them, so refresh runs in `src/proxy.ts` before the render                                                                          |
| [ADR-3](docs/adr/0003-sse-downstream-websocket-upstream.md)               | SSE downstream, WebSocket upstream                                        | Railway pushes log lines over GraphQL subscriptions, but App Router route handlers cannot accept WebSocket upgrades and the data only flows one way                                                                                                     |
| [ADR-4](docs/adr/0004-no-database.md)                                     | No database                                                               | Railway holds the state; mirroring it would only create drift                                                                                                                                                                                           |
| [ADR-5](docs/adr/0005-the-app-only-destroys-what-it-created.md)           | The app only acts on what it created                                      | This tool changes infrastructure, so ownership is the load-bearing safety property — the `spun-` name prefix is the marker, re-derived server-side before every destructive and mutating verb                                                           |
| [ADR-6](docs/adr/0006-docker-images-only.md)                              | Docker images only; GitHub sources are a stated limitation                | Repo sources silently require _the signed-in user's_ Railway account to have the GitHub app installed with access to that repo — something this app cannot provision on their behalf                                                                    |
| [ADR-7](docs/adr/0007-the-url-is-the-state.md)                            | The URL is the state; there is no client store                            | Project, environment and filters are search params, so the dashboard is linkable and the server does the fetching; there is no client fetch, so there is no client cache to reconcile                                                                   |
| [ADR-8](docs/adr/0008-a-hand-rolled-graphql-client-not-apollo.md)         | A hand-rolled GraphQL client, not Apollo                                  | All of `src/lib/railway/` is server-only, so Apollo's normalized cache and browser hooks have nothing to attach to — and a cache would be actively wrong for a live view of infrastructure                                                              |
| [ADR-9](docs/adr/0009-structured-logs-on-stdout.md)                       | Structured logs on stdout, with the OTel seam cut but not used            | The whole server used to log through one `console.error` that flattened everything a query would want — kind, status, operation, incident id — into a template string only `grep` could read                                                            |
| [ADR-10](docs/adr/0010-the-dashboard-watches.md)                          | The dashboard watches; it does not poll from the browser                  | A container created or destroyed in Railway's own dashboard did not appear here until someone pressed Refresh, and Railway publishes no project subscription — so someone has to poll, and the server does                                              |
| [ADR-11](docs/adr/0011-pnpm-stays.md)                                     | pnpm stays, and the migration was priced rather than assumed              | npm has no equivalent of `allowBuilds`, a per-package postinstall allowlist, and `pnpm audit --prod` re-evaluates reachability where an ignore-list of advisory ids decays                                                                              |
| [ADR-12](docs/adr/0012-idempotency-keys-replay-rather-than-reject.md)     | Idempotency keys on create, and a repeat is replayed rather than rejected | A name check is not a lock and cost a round trip before every create; a repeat now gets the first submission's answer, because "you already submitted this" is a false statement about a container that exists                                          |
| [ADR-13](docs/adr/0013-the-origin-is-the-request-not-a-variable.md)       | The origin is the request, not a variable                                 | One configured origin meant one working domain: a custom domain sent sign-in to the generated `*.up.railway.app` one. The origin is now derived per request from the forwarded host, validated, and https unless loopback                               |
| [ADR-14](docs/adr/0014-a-volume-belongs-to-the-service-that-mounts-it.md) | A volume belongs to the service that mounts it                            | Six presets kept state on a filesystem thrown away with the container. Railway does not cascade a delete to the volume, so destroy asks — box checked — and names the outcome either way; the gate is the service's prefix, never the volume's own name |

---

## The rail yard is decoration

[src/features/rail-yard/](src/features/rail-yard/) is the canvas animation behind the sign-in
card — trains routing over a track graph, a travelling gantry crane, a conveyor belt of containers.
It is **not** a visualisation of Railway data. It is a self-contained simulation with no
application logic in it at all, which is why it is worth naming here: it is a large directory
whose file names read like application code, and a reader looking for container logic should not
open it.

**The boundary is the filesystem.** `src/features/` exists for this and holds nothing else. Four
facts define it, each of them checkable:

- **One consumer.** [src/app/page.tsx](src/app/page.tsx) imports `RailYard` and renders it.
  Nothing else under `src/app`, `src/components`, `src/hooks` or `src/lib` imports from the
  directory. Two test-only readers do: `src/app/contrast.test.ts`, which reads its token list so
  a colour the canvas asks for and `tokens.css` does not declare fails the contrast gate, and
  `src/test/rail-yard.ts`, a helper the feature's own tests share.
- **Nothing beneath it imports `lib/railway/**`, `lib/auth/**`, `lib/logger`, `fetch` or
  `EventSource`.** No Railway data reaches it, no session touches it, it reads no application
  state, and it renders nothing a user acts on.
- **Its whole public surface is one small file** —
  [rail-yard.tsx](src/features/rail-yard/rail-yard.tsx), an `aria-hidden` `<canvas>` plus a hook.
  Everything else is simulation, geometry and 2D drawing behind it.
- **At runtime, deleting it would change the landing page and nothing else.** In the repo it
  would also take `src/test/rail-yard.ts`, break `src/app/contrast.test.ts`, and need edits in
  `eslint.config.mjs`, `vitest.config.mts`, `src/lib/constants.ts` and `bundle-budgets.json`.

Three consequences follow, each of which looks like an inconsistency from outside:

- **It owns its own tuned numbers**, in [config.ts](src/features/rail-yard/config.ts), with its
  sprite geometry beside them in `sprites.ts`. That is one of the two exceptions to "every tuned
  number goes in `src/lib/constants.ts`" — the other is the poll intervals in `src/env.ts` — and
  the constants file names both.
- **It is exempt from the appearance bans and from `no-non-null-assertion`** in
  `eslint.config.mjs`. A canvas has no CSS to inherit colours from, so it is the only place in
  `src/` that legitimately names one — and it reads them back out of the `--rc-*` tokens at
  runtime rather than inventing any.
- **It is not exempt from coverage.** It carries a directory floor in `vitest.config.mts` like
  `lib` and `hooks` do, because a large isolated module is the kind that decays unobserved.

It also has a budget consequence: it moved `/` by about 7 kB gzip and must never move
`/dashboard` or `/_not-found`, because it is its own client boundary. If those two ever change
for it, that is a defect and not a budget question —
[`bundle-budgets.json`](bundle-budgets.json) records the measurement.

The rules-level version of all this is
[`.ai/rules/architecture.md`](.ai/rules/architecture.md#srcfeatures-is-decoration-and-takes-part-in-none-of-the-above).

---

## Where else to look

| Document                                   | What it holds                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| [README.md](README.md)                     | Running it locally, deploying it, and the checks                             |
| [docs/limitations.md](docs/limitations.md) | What it deliberately does not do, and what I would do next                   |
| [docs/verifying.md](docs/verifying.md)     | The manual pass against a real Railway account                               |
| [docs/schema.md](docs/schema.md)           | Typed documents, `verify:schema`, and the probes for when a readout is empty |
| [docs/testing.md](docs/testing.md)         | The fake Railway, the mobile spec, and the known non-issues                  |
| [docs/frontend.md](docs/frontend.md)       | Design tokens, the type scale, loading states, i18n and accessibility        |
| [docs/performance.md](docs/performance.md) | How bundle budgets are measured and what moved them                          |
| [docs/logs.md](docs/logs.md)               | The log record's fields, and the path to Grafana                             |
| [docs/adr/](docs/adr/README.md)            | The fourteen decisions, argued in full                                       |
| [SECURITY.md](SECURITY.md)                 | The threat model, the findings, and the accepted risks                       |
| [`.ai/rules/`](.ai/rules/)                 | What you must do before writing code here                                    |
