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

| Path                                    | Role                                                             |
| --------------------------------------- | ---------------------------------------------------------------- |
| `src/proxy.ts`                          | Refreshes the Railway access token before the render (see ADR-2) |
| `src/lib/auth/`                         | OIDC flow, encrypted session cookie, refresh rotation            |
| `src/lib/railway/`                      | GraphQL client, mappers, status model, ownership marker          |
| `src/lib/railway/deployment-monitor.ts` | Merges status polling and the log subscription into one stream   |
| `src/lib/sse.ts`                        | SSE transport: framing, keepalive, duration ceiling              |
| `src/lib/constants.ts`                  | Every tuned number, grouped by the concern that owns it          |
| `src/app/tokens.css`                    | Design tokens — primitives, then the semantic layer the UI uses  |
| `src/components/ui/`                    | Primitives on Radix; features never hand-write a colour class    |
| `src/app/dashboard/`                    | Page, data loader, Server Actions                                |
| `e2e/fixtures/fake-railway/`            | Stand-in Railway: OIDC + GraphQL + graphql-ws                    |
| `scripts/verify-schema.ts`              | Checks every operation against the live Railway API              |

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
therefore runs in `src/proxy.ts`, which executes before the render and _can_ write. The
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

Services created elsewhere are listed for context but render as _Not managed here_ with
no destroy control — and `spinDown` re-derives ownership **server-side** before deleting,
so a forged request fails even though the user's own token would happily perform it.

### ADR-6 — Docker images only; GitHub sources are a stated limitation

`serviceCreate` accepts `source.image` or `source.repo`. Repo sources silently require
_the signed-in user's_ Railway account to have the GitHub app installed with access to
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
`deploymentStop` exists — if it does, spin-down can offer _stop_ alongside _destroy_
rather than destroy only.

CI runs the discovery half on every push.

---

## Running it

```bash
pnpm install
cp .env.example .env           # then fill in the values
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
pnpm check          # format + lint (0 warnings) + types + knip + coverage gate
pnpm test:e2e       # Playwright against the fake Railway fixture
pnpm build && pnpm size   # per-route first-load JS against bundle-budgets.json
pnpm lighthouse     # LHCI: scores + resource budgets, one Chrome
```

CI runs these on every push and pull request to `master`, as five parallel jobs behind a
single `All checks` gate for branch protection to require. Enabling that protection is a
GitHub repo setting, not a file — it is the one manual step.

---

## Internationalisation

Every user-facing string lives in `messages/en.json`. Components read it through
next-intl: `getTranslations` on the server, `useTranslations` on the client.

There is one locale, and that is a stopping point rather than an unfinished job — adding
a second is a translation task, not a refactor. Three things make that claim real rather
than aspirational:

- **`no-literal-string` (eslint-plugin-i18next)** on `src/**/*.tsx`. A hardcoded sentence
  fails the build. Without it the catalog decays on the next commit.
- **Typed keys.** `global.d.ts` declares the catalog as next-intl's `Messages`, so
  `t("dashboard.emptyTitle")` is checked by `tsc`. A renamed key breaks the build
  instead of rendering a missing-message marker.
- **Tests assert real copy.** The Vitest setup swaps next-intl's hooks for its own
  `createTranslator` over the actual `en.json`, so a misnamed ICU argument or a malformed
  plural fails a component test. A key-echoing stub would have hidden all of it.

Code that has no request scope — error classes, the log monitor — returns a
`MessageDescriptor` (`{ key, values }`) instead of a sentence, and the layer that renders
resolves it. That is what keeps a Railway failure one catalog key rather than English
frozen inside a `throw`.

Some cases needed more than a placeholder: `{managed} of {total} created here` is an ICU
plural, the managed-prefix note is rich text with a `<code>` chunk that translators can
move, and `relativeTime` now uses `Intl.RelativeTimeFormat` — the previous `${n}s ago`
was plural-blind and assumed the marker was a suffix, which it is not in German.

---

## Performance

Next 16 stopped printing route sizes, so `pnpm size` reads
`.next/diagnostics/route-bundle-stats.json`, gzips each chunk a route loads first, and
compares against `bundle-budgets.json`. Per route, no browser, ~2 seconds. (size-limit
cannot express this: Turbopack hashes every chunk name, so its config could only hold
globs, and a glob sums a directory instead of answering "what does /dashboard cost".)

Current: **/dashboard 203.5 kB**, **/ 161.5 kB**, **/\_not-found 142.1 kB** gzipped.

Two changes moved those numbers, and one that looked obvious did not:

- `ToastProvider` moved from the root layout to `dashboard/layout.tsx`. The landing page
  and the 404 were shipping Radix Toast — ~12 kB gzip — to render UI with no actions.
- The log pane is `next/dynamic`. It only mounts once a row is expanded, and it brings
  Radix ScrollArea with it.
- **Lazy-loading the destroy dialog's body was reverted.** It saved ~10 kB on paper, but
  Radix traps focus in whatever the dialog contains when it opens — and for the tick
  before the chunk arrived, that was nothing, so Tab walked straight out into the page
  behind. `e2e/keyboard.spec.ts` caught it. Removing the `next/dynamic` wrapper also made
  the route _smaller_, because the wrapper cost more than the split saved.

Lighthouse CI covers what a byte count cannot — fonts, CSS, and the rendered result — on
the landing page **and the authenticated dashboard**, which `scripts/lh-auth.ts` reaches
by driving the real OAuth flow against the fake Railway with Playwright. Accessibility is
gated at 100; the performance _score_ is a warning, because it swings on shared CI runners
and a gate that flakes is a gate everyone learns to ignore. The resource budgets beside it
are deterministic, so they gate hard.

`numberOfRuns` is 1. One Chrome, never a pool.

---

## Design system

Tokens live in `src/app/tokens.css` in two layers: raw ramps, then a semantic layer
(`--rc-canvas`, `--rc-text-muted`, `--rc-state-running`, …) which is the only thing the
UI is allowed to touch. `@theme inline` in `globals.css` maps the semantic layer onto
Tailwind utilities.

> The semantic tokens are named `--rc-*`, not `--color-*`. Mapping `--color-accent:
var(--color-accent)` is self-referential: Tailwind resolves it to whatever `:root`
> happens to hold, and the theme overrides silently stop applying — the dashboard
> rendered light-theme accents inside dark mode until the namespaces were separated.

Dark is the default, matching Railway's product; light follows `prefers-color-scheme`;
an explicit `[data-theme]` beats both, in either direction. Container-state colours are
resolved through a `data-state-color` attribute, so adding a state means adding a token
rather than editing a lookup table inside a badge.

Primitives in `src/components/ui/` are built on Radix. That buys real behaviour, not
styling: the destroy confirmation gets a focus trap, Escape handling and focus restore;
action feedback moves to an announced toast region; the raw Railway status enum moves
out of a `title` attribute, where keyboard and screen-reader users never saw it.

Appearance is enforced, not just documented. ESLint rejects raw palette utilities
(`bg-emerald-500/10`), hex literals and `[var(--…)]` arbitrary values in any `className`
outside `src/components/ui/**`, because each of those bypasses the semantic layer and
with it the light theme and the contrast test.

### Busy state

`Button` owns it: `pending` blocks activation, renders a spinner and sets `aria-busy`,
and `pendingLabel` swaps the text. Two details are load-bearing:

- **`disabled` does nothing to a link.** Under `asChild` the primitive renders through
  Radix `Slot`, and a slotted `<a>` ignores `disabled` entirely — it neither dims nor
  stops responding to Enter. The primitive uses `aria-disabled` and cancels the click
  instead, so no caller has to remember. It stays focusable: moving focus to `<body>`
  mid-action is worse than a focused control that declines to act.
- **The label swap is silent.** Assistive tech does not re-read the accessible name of
  the element it is already on, so progress goes through `PendingStatus`, a live region
  that stays mounted while idle — mounting the region and its text together is the
  classic way to have an announcement dropped.

Controls that hand the page to the browser (sign in, sign out, re-authorize) are full
document navigations, so `useFormStatus` and `useTransition` see nothing. They use
`useNavigationPending`, which raises the flag on activation and clears it on `pageshow`
— otherwise returning via bfcache, after declining Railway's consent screen, restores a
button that spins forever.

---

## Tests

Four tiers, each answering something the others cannot.

| Tier            | Runs on     | Covers                                                            |
| --------------- | ----------- | ----------------------------------------------------------------- |
| **unit**        | node        | Token rotation, status mapping, ownership, backoff, SSE framing   |
| **component**   | jsdom + RTL | Dialog guard, stream hook, autoscroll, keyboard on the primitives |
| **integration** | node + MSW  | Server Actions and route handlers against a mocked Railway        |
| **e2e**         | Playwright  | The real OAuth flow and lifecycle against a fake Railway          |

`pnpm test:coverage` enforces **80%** on lines, branches, functions and statements
across `src/**`. Framework shells (`page.tsx`, `layout.tsx`, `loading.tsx`, `error.tsx`)
are excluded and covered end-to-end instead — counting them would either inflate the
number or invite render tests that assert nothing. E2E does not feed the figure, so
component tests have to carry the UI. Current: 360 tests, ~94% lines.

One deliberate split: the sign-in button's busy state is a component test, not an e2e
one. It exists only between the click and the browser committing the next document, and
against the fixture that whole OAuth chain finishes in under 120ms — while forcing a
window open, by holding or aborting the request, makes Chrome tear down the document and
destroy the state under test.

### The fake Railway

`e2e/fixtures/fake-railway/` is a stand-in Railway on one port: an OIDC provider whose
`id_token` is genuinely RS256-signed and served through a real JWKS, a GraphQL API over
an in-memory store, and a hand-rolled `graphql-transport-ws` endpoint. Deployments
advance `QUEUED → BUILDING → DEPLOYING → SUCCESS` on a timer, so status transitions and
log streaming are real rather than snapshots.

The app runs unmodified against it — `RAILWAY_ISSUER` / `RAILWAY_API_URL` /
`RAILWAY_WS_URL` are the only difference — so PKCE, the token exchange and refresh-token
rotation are all exercised, rather than stubbed away by seeding a session cookie.
`POST /__test/faults` injects rate limits, revoked authorizations, failed builds and a
`slowMs` delay — busy state only exists while a request is in flight, so a spec that
means to assert on it slows the API down rather than racing it.

Playwright runs `workers: 1`: the fixture holds shared state that each spec resets.

---

## Accessibility

WCAG 2.1 AA, checked three ways because each misses what the others catch:

1. **`@axe-core/playwright`** on every meaningful state — landing, dashboard populated
   and empty, destroy dialog, log panel, form errors — **in both themes**.
2. **`src/app/contrast.test.ts`** parses `tokens.css` and computes the contrast ratio of
   every declared pair in both themes. It runs in milliseconds without a browser and
   covers colours no spec happens to visit; it is what makes promising two themes safe.
   It has already caught four real failures.
3. **Keyboard specs** (`e2e/keyboard.spec.ts`) for focus traps, focus restore, roving
   tabindex, Escape and live-region politeness. Axe cannot see any of that — and they
   are what make replacing a native `<select>` with a Radix one defensible.

Axe misses more than timing. The unmanaged-container control passed every scan while
showing "Not managed here" under an accessible name of "Why can't postgres be
destroyed?" — no shared words, so voice control could not address the thing on screen
(WCAG 2.5.3 Label in Name). Nothing automated flagged it.

Plus `eslint-plugin-jsx-a11y` at strict, with CI failing on any warning.

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
   _Not managed here_, with no destroy control.
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
