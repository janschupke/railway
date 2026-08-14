---
meta:
  updated: 2026-08-14
---

# Workflow

## `pnpm check` is the gate

```sh
pnpm check
```

is `format:check && lint && typecheck && codegen:check && knip && test:coverage`. **Run it
before saying anything is done.** `pnpm format` fixes the formatting half, and `pnpm codegen`
fixes the codegen half — `codegen:check` regenerates the GraphQL types and fails if the
result differs from what is committed, so a document edited without regenerating stops here.

CI adds four things `pnpm check` does not run: `pnpm build && pnpm size`, `pnpm test:e2e`,
`pnpm lighthouse`, and `pnpm verify:schema`. Run whichever your change can reach — the
per-rule files say which.

## Knip findings fail; dead code is an error

`pnpm knip` reports unused files, dependencies and exports, and CI gates on it. Next's App
Router has no single entry point, so `knip.jsonc` lists page/layout/route files,
`scripts/*.ts`, the e2e specs and the fixture server explicitly. `src/proxy.ts` and
`src/instrumentation.ts` are **not** in that list — knip's Next plugin detects them. **A new entry point that is not reachable from
those patterns must be added there**, or the whole subtree reports as unreachable.

`src/test/**` is ignored, which has a consequence worth knowing: an import _from_ a test
helper does not register as usage, so a symbol consumed only from `src/test/` is reported
dead. That is why `src/test/log-capture.ts` imports nothing from `src/lib`.

## CI

`.github/workflows/ci.yml`, on push and PR to `master` plus a Monday cron, six jobs plus an
aggregator:

| Job        | What it runs                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `quality`  | `pnpm audit --prod --audit-level=high` (gating) + full-tree audit (advisory), prettier, eslint, tsc, codegen drift, knip, coverage                                 |
| `build`    | `pnpm build`, then `pnpm size`                                                                                                                                     |
| `browser`  | Playwright — both the `chromium` and `mobile` projects — then `pnpm serve:e2e` backgrounded and LHCI, in one job                                                   |
| `image`    | hadolint, `docker build`, boot the image against `/api/health`, then Trivy on what was built                                                                       |
| `secrets`  | gitleaks over the whole history                                                                                                                                    |
| `schema`   | `pnpm verify:schema` — OIDC discovery, plus every document validated against the committed schema; the live comparison needs `RAILWAY_TOKEN`, which CI has none of |
| `required` | aggregator named **"All checks"**, the single name branch protection requires                                                                                      |

**A new job has to be added to `required`'s `needs`.** From the aggregator, a job that was
never listed is indistinguishable from one that does not exist, so branch protection goes
green with nothing behind it. `src/toolchain.test.ts` derives the list from the jobs the
file defines and fails when the two disagree.

The three scanners run as **digest-pinned container images inside `run:` steps** rather than
as actions. `gitleaks-action` is proprietary and wants a write scope to comment on pull
requests, which this workflow does not grant; one mechanism for three tools beats two; and
every one of those commands runs verbatim on a laptop. The cost is that Dependabot does not
reach a digest inside a `run:` step, so those three are bumped by hand against the version
comment beside each. Its `docker` ecosystem does cover the Dockerfile's base image.

CI injects placeholder credentials at the workflow level. **The build and the e2e fixture
must not need real credentials** — if the env schema starts demanding them, that is a
legitimate CI failure, not something to work around. The `image` job forwards those same
four into the container it boots with valueless `--env NAME`, so they are still written
once.

## Node, TypeScript, tooling

- **Node 22**, named in three places that must agree: `engines.node: "22.x"` in
  package.json, the two `FROM node:22.x.y-alpine@sha256:…` lines in the Dockerfile, and
  `node-version` in the four CI jobs that install Node. Pinned to a major rather than a
  floor — `>=22` lets a builder resolve to whatever it has newest, a different runtime
  arriving without a commit.
- **The base image carries a digest as well as a tag**, and both `FROM` lines carry the
  same one. A tag is a pointer its owner can move, which is what pinning the actions was
  about; the base image was the last mutable reference in the deployment path. Dependabot's
  `docker` ecosystem bumps it — a pinned digest with nothing bumping it is a version that
  quietly stops receiving fixes, and the CI image scan gates on fixable CVEs.
- **pnpm 11.9.0**, pinned via `packageManager` _and_ installed by exact version in the
  Dockerfile. pnpm is not incidental — `pnpm-workspace.yaml`'s `allowBuilds` is a
  postinstall allowlist npm cannot express, and `pnpm audit --prod` is the shape the CI
  gate argues for. [ADR-11](../../docs/adr/0011-pnpm-stays.md) prices the alternative.
- **Nothing in the deployment path may consult `packageManager`.** That field is a
  corepack instruction, and corepack's own version belongs to whatever base image is in
  use, not to this repository. See the deployment section for the failure that taught us
  this. The Dockerfile installs pnpm from npm for the same reason.
- `src/toolchain.test.ts` holds all of the above to each other: the `FROM` major against
  `engines.node`, the runtime stage's base image against the build stage's, the installed
  pnpm against `packageManager`, every CI `node-version` against the deployed major, and
  the Dockerfile against ever running `corepack enable`. Each pair is two literals with
  nothing between them. It also holds `ci.yml`'s job list against `required`'s `needs`,
  which is not a pair of literals but fails in the same silent way.
- Files under `scripts/` run on Node's type-stripping loader
  (`node --experimental-strip-types`), which is why `allowImportingTsExtensions` is on and
  why those imports carry explicit `.ts` specifiers. Safe because the project never emits.
  `src/lib/railway/documents.ts` carries one too, and is the only file under `src/` that
  does: `verify-schema.ts` reaches it, so that loader resolves its imports as written.
- **`src/lib/railway/schema.graphql` and `graphql.generated.ts` are generated and committed.**
  `pnpm schema:pull` writes the first from live introspection and needs `RAILWAY_TOKEN`;
  `pnpm codegen` writes the second from it and needs nothing, which is what lets CI check
  both without a credential. Do not hand-edit either. The SDL is in `.prettierignore` —
  `printSchema` is its normaliser — while the generated types are prettier-formatted by a
  codegen hook so `format:check` has nothing to say about them.
- `noUncheckedIndexedAccess` is on. An index read is `T | undefined` — Relay connections and
  preset arrays are indexed all over this codebase. **Narrow it; do not `!` it away.**
- Also on: `noFallthroughCasesInSwitch`, `noImplicitOverride`, `isolatedModules`.
- Prettier: 88 columns, double quotes, `trailingComma: "all"`, plus
  `prettier-plugin-tailwindcss`. It formats markdown too, so a new `.md` file must be
  formatted or `pnpm check` fails.
- `eslint-config-prettier` must stay **last** in `eslint.config.mjs`.

## Git

- **Never create a branch.** Work on `master`.
- **Commit subjects are sentence-case prose naming the outcome**, not Conventional Commits.
  Real examples: `One shell for every route, a real 404, and a brand mark on disk`,
  `Promote the variables mutation from probed to required`,
  `Security review: headers, a token leak, error-detail policy, stream limits`.
- **Bodies are long and explain themselves** — the defect, the reasoning, the alternative
  that was rejected and why, and measured deltas where a number changed. Wrapped at ~76
  characters, bullet lists for the local fixes. A one-line body is almost always
  under-explaining.
- `AGENTS.md` carries a `<!-- BEGIN:nextjs-agent-rules -->` block that `next dev` writes and
  re-adds. **Commit it with your work.** Removing it from a diff only re-creates the
  uncommitted change.

## Deployment

Railway, **`DOCKERFILE` builder** — see `railway.json` and the `Dockerfile`. Healthcheck
`/api/health` with a 60 s timeout, restart `ON_FAILURE` ×3. There is **no
`startCommand`**: the runtime stage has no package manager in it, so `pnpm start` would
build cleanly and then fail to boot. `CMD` runs `node server.js` directly.

## `output: "standalone"`, and what it costs

The runtime image copies `.next/standalone` — a traced server — rather than installing
production dependencies. Measured: **504 MB of app payload became 44 MB**, and the
`prod-deps` stage is gone.

The gap was not fat. pnpm resolves optional peer dependencies at lockfile time and writes
them into the resolved package's identity —
`next@16.3.0(@babel/core@7.29.7)(@playwright/test@1.62.1)(@types/node@20.19.43)…` — so
`pnpm install --prod` could not remove them: it prunes root devDependencies, and these were
part of the name of a production one. Playwright, TypeScript, `@types/node` and the Babel
closure shipped to production because they are devDependencies of the same package.json.
Tracing asks what the code imports, and none of them answer.

Four consequences to work with rather than around:

- **`next start` does not serve a standalone build.** `pnpm start`, `playwright.config.ts`
  and `scripts/serve-e2e.ts` all run `node .next/standalone/server.js`, which takes no
  arguments — the port comes from `PORT`. A new consumer of a production build does the
  same.
- **`HOSTNAME` is now read, and its default is wrong for Railway.** `server.js` binds
  `process.env.HOSTNAME || '0.0.0.0'`, and `0.0.0.0` is the IPv4 wildcard and no IPv6
  interface at all; `next start` bound `::`, which is dual-stack and takes both. Railway
  routes internally over IPv6. The `Dockerfile` sets `HOSTNAME="::"` for that reason and
  `playwright.config.ts` and `scripts/serve-e2e.ts` repeat it, so what the suite exercises
  listens where the deployment does. The boot log names the address it took, so a
  deployment that lost that line says so instead of failing a healthcheck anonymously.
- **`pnpm build` is not finished without `postbuild`.** `scripts/pack-standalone.ts` copies
  `.next/static` in, which `next build` deliberately omits, and without it every page
  answers 200 while every chunk, stylesheet and font 404s. It also asserts the message
  catalog was traced, and deletes the `.env` that `next build` copies in — see
  [security.md](security.md).
- **`next.config.ts` is not read at runtime any more.** The resolved config is inlined into
  `server.js` and `headers()` is baked into `.next/routes-manifest.json` at build time.
  That is what removed the native SWC compiler from the image: `next start` used to compile
  this file on every boot. **A config value that only exists as a function evaluated at
  request time would not survive** — nothing here is one, and `e2e/security.spec.ts` reads
  the headers off a live response.

**CI builds that image, boots it and scans it** before it can reach Railway — the `image`
job. That is the gate a change to this file has to clear, and it is deliberately more than
a build: a missing `COPY` or a `CMD` reaching for something the runtime stage does not have
compiles perfectly and fails at deploy as "Healthcheck failure", which names nothing. The
job runs the container with the workflow's placeholders and waits for `/api/health` to
answer 200. It prints the container's logs either way, because those records are the
diagnostic.

The runtime stage **removes npm**, which the base image ships and nothing here calls. Same
rule as pnpm's absence, and it is what makes an unqualified `HIGH,CRITICAL` image scan
gate on zero: every finding otherwise reported sits inside npm's own bundled dependencies,
which no commit in this repository can fix.

The image carries OCI labels, including `org.opencontainers.image.revision` from
`RAILWAY_GIT_COMMIT_SHA` — the same value `src/lib/logger.ts` emits as `version`. It
defaults to empty, so a local `docker build` is unaffected.

The service needs three variables: `RAILWAY_CLIENT_ID`, `RAILWAY_CLIENT_SECRET`, and a
`SESSION_SECRET` of at least 32 characters.

**And a public domain.** `APP_URL` is the fourth required field and nobody sets it in
production — it is derived from `RAILWAY_PUBLIC_DOMAIN`, which Railway injects only once
the service _has_ a domain, not on every deployment. A new service has neither, so `env()`
fails, `/api/health` answers 503 by design, and the platform reports **"Healthcheck
failure"** with nothing about a missing variable in it. Generate a domain under Settings →
Networking, or set `APP_URL` explicitly. The schema message names `RAILWAY_PUBLIC_DOMAIN`
for this reason, and `boot.env_invalid` puts it in the deploy log before the first request.

The build sets a placeholder for those four inline on the `pnpm build` command, so nothing
outside can override them and no image layer records them — the same rule `ci.yml` states,
enforced rather than restated.

### Why not NIXPACKS

It resolved `pnpm` to the corepack shim in its Node derivation. corepack read
`packageManager`, downloaded pnpm 11.9.0, and compiled its entry point — a three-line CJS
shim whose only statement is `import('./pnpm.mjs')` — without a dynamic-import callback:

```
TypeError [ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING]
    at .../corepack/pnpm/11.9.0/bin/pnpm.cjs:3:1
    at Module2._compile (.../corepack/dist/lib/corepack.cjs)
```

Reproduced by version: corepack 0.20.0 and 0.24.1 fail exactly this way and cache to
`corepack/pnpm/11.9.0`, which is the path the deploy log printed; 0.31.0 and later succeed
and cache to `corepack/v1/pnpm/11.9.0`, which it did not. **The cause was the builder's
corepack**, which no file in this repository can pin — which is why declaring
`engines.node` moved the Node in the trace from 18.20.5 to 22.14.0 and changed nothing
else.

The Dockerfile is not chosen for control alone. It can be built and run on a laptop, so a
deployment change is testable before it is a deployment: `docker build -t rw . && docker
run --rm -p 3000:3000 -e SESSION_SECRET=… -e RAILWAY_CLIENT_ID=… -e
RAILWAY_CLIENT_SECRET=… -e RAILWAY_PUBLIC_DOMAIN=… rw`. Two guesses at builder
configuration went out untested before this one did not. That property is why the CI
scanners are `docker run` commands rather than actions — every gate on this file can be
reproduced locally, byte for byte.

Single replica by design — the SSE stream slot counter is in-memory and per replica, and SSE
pins a client to one replica anyway.

## Dates

Run `date +%F` rather than assuming. ISO 8601 (`YYYY-MM-DD`) in file names, frontmatter and
technical contexts; natural format in prose.

## Scoped commands

`/plan`, `/audit`, `/audit-scatter`, `/audit-security`, `/bugfix` and `/refactor` are
registered as user-level skills, not in this repo. They apply here unchanged; there is no
`.ai/commands/` to keep in sync.

## Before you call this done

```sh
pnpm check
```

If you touched the `Dockerfile`, the four gates `pnpm check` does not run — the same
commands `ci.yml` runs, one at a time:

```sh
docker run --rm -i ghcr.io/hadolint/hadolint@sha256:a1d49ae1… \
  hadolint --failure-threshold info --ignore DL3059 --ignore DL3066 - < Dockerfile
docker build -t rw . && docker run --rm -d --name rw -p 3000:3000 \
  -e RAILWAY_CLIENT_ID=x -e RAILWAY_CLIENT_SECRET=y \
  -e SESSION_SECRET=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  -e APP_URL=http://localhost:3000 rw
docker save rw -o /tmp/rw.tar && docker run --rm -v /tmp:/w -w /w \
  ghcr.io/aquasecurity/trivy@sha256:7cced7ca… image --input rw.tar \
  --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1
```

Curl `/api/health` for 200, then **open the page**. Two failure modes pass the health check
and break the first render: an untraced message catalog 500s, and a missing `.next/static`
serves the HTML with every asset 404ing. `pnpm test:e2e` covers both, since it now runs the
same `server.js`.

and, if the tree was already dirty when you started, confirm you changed only what you
meant to:

```sh
git status --short
```
