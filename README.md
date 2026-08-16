# Railway Freight Loader

Spin containers up and down in **your own** Railway projects, from a browser.

**Live: <https://trains.schupke.io>** — signing in needs a Railway account, and it only ever
acts on that account's own projects.

> **New here? Start with the [walkthrough](walkthrough.md)** — what the app does, where the
> interesting code is, and why it is shaped the way it is. This file is how to run it.

Sign in with Railway, pick which projects to share on Railway's consent screen, choose a project
and environment, and create Docker-image services — then stop, restart, redeploy, roll back or
destroy them — with live build and deploy logs streamed while it happens.

- Twelve-image preset catalog, or any image reference you type
- Region, replicas, vCPU, memory, restart policy and start command at create time
- Environment variables, generated passwords, and an optional public address
- Volumes attached automatically to the presets that keep state
- Six lifecycle verbs, every one gated by an ownership marker re-derived on the server
- Live logs over SSE, with search, filtering, copy and download
- A server-side watcher that notices changes made in Railway's own dashboard
- No database, no client store, and the access token never leaves the server in plaintext

---

## Running it

```bash
pnpm install
cp .env.example .env           # then fill in the values
pnpm dev
```

Register the OAuth app under your Railway workspace's **Developer settings**, with one redirect
URI per domain the app is reached on (they must match exactly):

```
http://localhost:3000/api/auth/callback
https://<your-deployment>.up.railway.app/api/auth/callback
```

The deployed instance also registers `https://trains.schupke.io/api/auth/callback`. Sign-in
follows the domain the request arrived on, so a domain whose callback is not registered is
refused by Railway rather than by this app.

`SESSION_SECRET` can be anything with enough entropy: `openssl rand -base64 32`.

Node 22 and pnpm are both pinned in `package.json`; there is no workspace, and
`pnpm-workspace.yaml` exists only to carry the `allowBuilds` allowlist
([ADR-11](docs/adr/0011-pnpm-stays.md)).

---

## Deploying

Connect the repo to Railway; `railway.json` points it at the `Dockerfile` and sets the
`/api/health` healthcheck. There is no start command there — the image carries its own, and the
runtime stage has no package manager to run one with. Set `RAILWAY_CLIENT_ID`,
`RAILWAY_CLIENT_SECRET` and `SESSION_SECRET` as service variables. There is no origin to
configure: the app serves whatever domain the request arrived on.

### Custom domains

Point the domain at the service and register its `/api/auth/callback` on the OAuth app. That is
the whole procedure — no variable to set, and any number of domains work at once. Two
consequences worth knowing:

- **Sessions are per domain.** The session cookie carries the `__Host-` prefix, which binds it to
  exactly one origin, so signing in on one domain does not sign you in on another.
- **`APP_ORIGINS` locks it down** if you would rather the app answered only for domains you have
  listed. Unset, it answers for any host Railway's edge reports —
  [ADR-13](docs/adr/0013-the-origin-is-the-request-not-a-variable.md) argues why that is safe
  here. Setting it does not implicitly include the generated `*.up.railway.app` domain; list every
  domain you serve.

### The image

The `Dockerfile` pins its base image by sha256 digest as well as by tag, on both `FROM` lines, and
the runtime stage strips npm, corepack and yarn — none of which the app calls and all of which the
base image ships. The deployed image carries OCI labels, including
`org.opencontainers.image.revision`, taken from `RAILWAY_GIT_COMMIT_SHA`: the same commit the
logger stamps on every line, on the artefact rather than only in its output.

It ships a **traced** `node_modules` — `output: "standalone"` — rather than an installed one. Two
consequences to work with:

- **`next start` does not serve a standalone build.** `pnpm start`, the Playwright `webServer` and
  `scripts/serve-e2e.ts` all run `node .next/standalone/server.js` — the same file the container
  runs — and it takes no arguments, so the port comes from `PORT`.
- **`pnpm build` is not finished without `postbuild`.** `scripts/pack-standalone.ts` copies in the
  static assets Next deliberately leaves out, checks the message catalog was traced, and deletes
  the `.env` that `next build` otherwise copies next to the server. Without it every page answers
  200 while every chunk, stylesheet and font 404s.

Why standalone, and what it costs, is in
[.ai/rules/workflow.md](.ai/rules/workflow.md).

---

## Checks

```bash
pnpm check          # format:check + lint + typecheck + codegen:check + cursor:check + knip + test:coverage
pnpm build && pnpm test:e2e   # Playwright against the fake Railway fixture
pnpm build && pnpm size       # per-route first-load JS against bundle-budgets.json
pnpm lighthouse     # LHCI: scores + resource budgets, one Chrome
pnpm verify:schema  # pinned OIDC metadata, and every document against the committed schema
```

Two more gates have no local script at all, because what they check is not the source tree.

```bash
docker build -t rw .   # then boot it and curl /api/health; hadolint and Trivy over it
                       # — the exact commands are in .ai/rules/workflow.md
gitleaks git --log-opts=--all   # the whole history, every run, redacted
```

CI runs these on every push and pull request to `master`, plus a Monday cron, as six parallel
jobs behind a single `All checks` gate. CodeQL runs alongside them on the same events, in its
own workflow because it needs a wider permission than the rest.
`.github/pull_request_template.md` names the same commands, so a pull request states which of them
ran locally rather than leaving the split to prose.

One step of `pnpm check` has no CI equivalent: `cursor:check`, which regenerates
`.cursor/rules/main.mdc` from `AGENTS.md` and compares. Editing `AGENTS.md` without running
`pnpm cursor:generate` leaves that file stale and CI stays green, so it is a local gate only.

The image job builds the image cold, boots it, waits for `/api/health`, and scans the result.
The build is uncached on purpose, because a cached one here can go green while the build Railway
runs does not.

Enabling branch protection is a GitHub repo setting, not a file — Settings → Branches → Add branch
protection rule, pattern `master`, _Require status checks to pass before merging_ with **All
checks** selected. Selecting that one name is enough: `required` is an aggregator that fails
unless every job in its `needs` list reported success, so the protection rule never has to be
re-edited when a job is added — only `needs` does, and `src/toolchain.test.ts` fails when the two
disagree. It is the one manual step.

To check it by hand against a real account, work through [docs/verifying.md](docs/verifying.md).

---

## Everything else

[walkthrough.md](walkthrough.md) indexes every other document — the code map, the fourteen
decisions in [docs/adr/](docs/adr/README.md), and the long-form reference under [docs/](docs/).
[SECURITY.md](SECURITY.md) holds the threat model and the accepted risks;
[`.ai/rules/`](.ai/rules/) holds what you must do before writing code here.

---

## License

MIT — see [LICENSE](LICENSE).
