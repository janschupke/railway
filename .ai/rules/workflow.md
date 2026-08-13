---
meta:
  updated: 2026-08-13
---

# Workflow

## `pnpm check` is the gate

```sh
pnpm check
```

is `format:check && lint && typecheck && knip && test:coverage`. **Run it before saying
anything is done.** `pnpm format` fixes the formatting half.

CI adds four things `pnpm check` does not run: `pnpm build && pnpm size`, `pnpm test:e2e`,
`pnpm lighthouse`, and `pnpm verify:schema`. Run whichever your change can reach — the
per-rule files say which.

## Knip findings fail; dead code is an error

`pnpm knip` reports unused files, dependencies and exports, and CI gates on it. Next's App
Router has no single entry point, so `knip.jsonc` lists page/layout/route files, the proxy,
`scripts/*.ts` and the e2e specs explicitly. **A new entry point that is not reachable from
those patterns must be added there**, or the whole subtree reports as unreachable.

`src/test/**` is ignored, which has a consequence worth knowing: an import _from_ a test
helper does not register as usage, so a symbol consumed only from `src/test/` is reported
dead. That is why `src/test/log-capture.ts` imports nothing from `src/lib`.

## CI

`.github/workflows/ci.yml`, on push and PR to `master`, five jobs plus an aggregator:

| Job          | What it runs                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------- |
| `quality`    | `pnpm audit --prod --audit-level=high` (gating) + full-tree audit (advisory), prettier, eslint, tsc, knip, coverage |
| `build`      | `pnpm build`, then `pnpm size`                                                                                      |
| `e2e`        | Playwright chromium against the fake Railway                                                                        |
| `lighthouse` | `pnpm serve:e2e` backgrounded, then LHCI                                                                            |
| `schema`     | `pnpm verify:schema` — OIDC discovery drift only, since CI holds no `RAILWAY_TOKEN`                                 |
| `required`   | aggregator named **"All checks"**, the single name branch protection requires                                       |

CI injects placeholder credentials at the workflow level. **The build and the e2e fixture
must not need real credentials** — if the env schema starts demanding them, that is a
legitimate CI failure, not something to work around.

## Node, TypeScript, tooling

- **Node 22**, pnpm 11.9.0 (pinned via `packageManager`). No `.nvmrc`.
- Files under `scripts/` run on Node's type-stripping loader
  (`node --experimental-strip-types`), which is why `allowImportingTsExtensions` is on and
  why those imports carry explicit `.ts` specifiers. Safe because the project never emits.
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

Railway itself, NIXPACKS. `railway.json`: `startCommand: pnpm start`, healthcheck
`/api/health` with a 60 s timeout, restart `ON_FAILURE` ×3. `APP_URL` is derived from
Railway's injected `RAILWAY_PUBLIC_DOMAIN` in production and only needs setting locally.

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

and, if the tree was already dirty when you started, confirm you changed only what you
meant to:

```sh
git status --short
```
