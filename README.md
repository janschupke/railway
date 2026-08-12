# Container Console

Spin containers up and down in **your own** Railway projects, from a browser.

Sign in with Railway, pick which projects to share on Railway's consent screen, choose a
project and environment, and create or destroy Docker-image services — with live build
and deploy logs streamed while it happens.

---

## Architecture

```
Browser ──── SSE ────► Next.js (single Railway service)
   ▲                        │
   │                        ├── HTTPS  ─► backboard.railway.com/graphql/v2   (mutations, queries)
   │                        └── WSS    ─► backboard.railway.com/graphql/v2   (log subscriptions)
   │
   └── Server Components render the container list; Server Actions mutate.
       The Railway access token never leaves the server.
```

One process, one deployment. Server Components read, Server Actions write, and a single
SSE route multiplexes deployment status and log output into the open tab.

| Path | Role |
| --- | --- |
| `src/proxy.ts` | Refreshes the Railway access token before the render (see ADR-2) |
| `src/lib/auth/` | OIDC flow, encrypted session cookie, refresh rotation |
| `src/lib/railway/` | GraphQL client, operations, status model, ownership marker |
| `src/app/api/streams/[deploymentId]/` | SSE downstream, graphql-ws upstream |
| `src/app/dashboard/` | Dashboard page + Server Actions |
| `scripts/verify-schema.ts` | Checks every operation against the live Railway API |

---

## Decisions

### ADR-1 — Railway OIDC directly, not an auth vendor

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

**Why not Auth.js:** it remains `5.0.0-beta.x` and unproven against Next 16. The flow
here is a single provider and about 150 explicit lines, which is also easier to read
than a config object.

**The scope that matters is `project:admin`.** Railway's prose scope table lists only
`viewer` and `member` for projects; `project:admin` appears in the live discovery
document's `scopes_supported`. `pnpm verify:schema` asserts it is still advertised.

### ADR-2 — Token refresh runs in the proxy layer

Railway access tokens live **one hour** and refresh tokens **rotate on every use**. A
demo that dies 60 minutes in is the specific failure this app invites, so refresh is not
an afterthought.

Server Components can read cookies but not write them, so a refresh during render would
rotate the token and then lose it — and the spent refresh token is gone. Refresh
therefore runs in `src/proxy.ts`, which executes before the render and *can* write. The
new cookie is set on the **request** as well as the response, so the render that
triggered the refresh already sees the fresh token. Server Actions and Route Handlers
carry a fallback path (`requireAccessToken`) since they can write cookies too.

### ADR-3 — SSE downstream, WebSocket upstream

Railway streams build and deploy logs as GraphQL subscriptions over
`wss://backboard.railway.com/graphql/v2` — the same transport `railway logs` uses. So
log lines are genuinely pushed.

The browser leg is SSE, not WebSocket, because Next's App Router cannot accept WebSocket
upgrades in a route handler, and the data only flows one way. No custom server needed.

**Status is the honest exception.** Railway exposes log subscriptions but no
deployment-status subscription, so status is polled — bounded to one deployment, only
while it is transitioning, with the whole stream closing at a terminal state. That is a
different cost profile from a dashboard-wide poll, which would burn a Hobby plan's
1000 requests/hour quickly.

### ADR-4 — No database

Railway holds the state; mirroring it would only create drift. The dashboard queries
project → services → `latestDeployment` in one request and streams deltas after that.

### ADR-5 — The app only destroys what it created

This tool deletes infrastructure, so ownership is the load-bearing safety property.

Railway services carry no arbitrary metadata, and a per-service variable lookup would
cost a round-trip per row against a low rate limit. So the **name prefix** (`spun-` by
default) is the marker: it comes back in the same query that lists services, and it is
visible in Railway's own dashboard rather than hidden.

Services created elsewhere are listed for context but render as *Not managed here* with
no destroy control — and `spinDown` re-derives ownership **server-side** before deleting,
so a forged request fails even though the user's own token would happily perform it.

### ADR-6 — Docker images only; GitHub sources are a stated limitation

`serviceCreate` accepts `source.image` or `source.repo`. Repo sources silently require
*the signed-in user's* Railway account to have the GitHub app installed with access to
that repo — something this app cannot provision on their behalf. Image sources work for
anyone, so that is the product surface. See "Limitations".

---

## Schema verification

Railway publishes no schema artifact, and their API guides omit several things this app
depends on. Rather than assume, `scripts/verify-schema.ts` introspects the live API and
checks every root field the app sends, plus re-fetches the OIDC discovery document and
diffs it against the pinned metadata:

```bash
pnpm verify:schema                       # discovery checks only
RAILWAY_TOKEN=… pnpm verify:schema       # + full schema introspection
```

Get a token at <https://railway.com/account/tokens>. It also reports whether
`deploymentStop` exists — if it does, spin-down can offer *stop* alongside *destroy*
rather than destroy only.

CI runs the discovery half on every push.

---

## Running it

```bash
pnpm install
cp .env.example .env.local     # then fill in the values
pnpm dev
```

Register the OAuth app under your Railway workspace's **Developer settings**, with both
redirect URIs (they must match exactly):

```
http://localhost:3000/api/auth/callback
https://<your-deployment>.up.railway.app/api/auth/callback
```

`SESSION_SECRET` can be anything with enough entropy: `openssl rand -base64 32`.

### Deploying

Connect the repo to Railway; it detects Next.js and reads `railway.json` for the start
command and `/api/health` healthcheck. Set `RAILWAY_CLIENT_ID`, `RAILWAY_CLIENT_SECRET`
and `SESSION_SECRET` as service variables — `APP_URL` is derived from Railway's injected
`RAILWAY_PUBLIC_DOMAIN`.

The app deploys itself the same way it deploys containers.

### Checks

```bash
pnpm check     # typecheck + lint + tests
```

---

## Verifying it works

1. Sign in. Railway's consent screen should list your projects — select at least one.
2. Spin up `redis:7-alpine`. The row should move Queued → Building → Deploying →
   Running, with build output streaming in the expanded log pane.
3. Destroy it (type the container name to confirm) and check it disappears from the
   Railway dashboard too.
4. **Token expiry:** leave the tab open past the hour, or rewind `expiresAt` in the
   session cookie, then perform an action. It should succeed — the proxy refreshes and
   rotates transparently.
5. **Ownership:** create a service in the Railway dashboard directly. It appears here as
   *Not managed here*, with no destroy control.
6. **Failure paths:** submit `nonexistent/image:tag` and confirm it settles into
   **Failed** with build logs, rather than spinning forever. Revoke the app's
   authorization mid-session and confirm you are sent back to sign in with an
   explanation, not a stack trace.

---

## Limitations

- **GitHub-repo sources are not offered** (ADR-6). Supporting them means detecting
  whether the signed-in user's Railway account has the GitHub app installed, and sending
  them to install it — a real feature, not a line of code.
- **Private registries are not supported.** `serviceCreate` would need credentials this
  app does not collect.
- **Spin-down means destroy.** Whether a stop-without-destroy mutation exists is
  reported by `pnpm verify:schema`; until confirmed, the UI does not promise it.
- **SSE pins a client to one replica**, so this is a single-replica app today. See below.
- **A stream open for more than an hour** outlives its access token. Deploys finish well
  inside that; a long-lived streaming session would need mid-stream token rotation.
- **Double-submit protection is a name check, not a lock.** Two truly simultaneous
  submissions could still create two services.

## What I would do next

- **Scale-out:** extract a WebSocket gateway service with Redis pub/sub, holding one
  upstream subscription per deployment and fanning out to N viewers, instead of one
  upstream connection per viewer per replica. That is what SSE's replica affinity forces
  once there is more than one instance.
- **An audit log** of spin-up/spin-down per user — the one thing genuinely worth a
  database, since Railway does not retain it once a service is deleted.
- **Idempotency keys** on create, replacing the name pre-check.
- **Budget guards:** a per-user cap on concurrent containers, and a TTL that reaps them
  automatically — the obvious next thing for a tool whose whole purpose is creating
  billable infrastructure.
