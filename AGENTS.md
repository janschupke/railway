<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Railway Freight Loader

One Next.js 16 App Router app, single package, pnpm. A visitor signs into **their own**
Railway account over OIDC, picks or creates a project and environment, and creates or
destroys Docker-image services with live build and deploy logs streamed into the browser.
There is no database, no client store, and the visitor's token never leaves the server.

All detailed rules live in [`.ai/rules/`](.ai/rules/) — the single source of truth. The
reasoning behind each decision lives in [`docs/adr/`](docs/adr/README.md) (fourteen ADRs)
and [SECURITY.md](SECURITY.md) (the OWASP review, the findings, and the accepted risks). Read
the relevant rule before touching auth, the design tokens, the log stream, or a CI gate.

For orientation rather than rules, [walkthrough.md](walkthrough.md) maps the features onto the
code, indexes the ADRs, and marks the boundary of `src/features/rail-yard/` — decoration that no
application lane touches. The long-form reference a change may need to keep in step is under
[`docs/`](docs/): [limitations](docs/limitations.md), [schema](docs/schema.md),
[testing](docs/testing.md), [frontend](docs/frontend.md), [performance](docs/performance.md),
[logs](docs/logs.md).

## Rules

[`.ai/rules/README.md`](.ai/rules/README.md) states the rule about the rules: one fact, one
home, and every other mention is a sentence and a link. Read it before adding to any of
these files.

- [Architecture](.ai/rules/architecture.md) — RSC reads / Server Actions write / two SSE routes, `src/proxy.ts`, the managed-name ownership rule, import boundaries, `src/lib/constants.ts`, `src/env.ts`
- [Design system](.ai/rules/design-system.md) — two token layers (`--rc-*`), the seven-step type scale defined in four files, and the four appearance bans on feature components
- [Internationalisation](.ai/rules/i18n.md) — every string in `messages/en.json`, type-checked keys, `MessageKey` for code that cannot translate itself
- [Testing](.ai/rules/testing.md) — four Vitest projects plus Playwright, colocated, a ratcheted coverage gate, asserted log records, and the fake Railway with its fault injection
- [Security](.ai/rules/security.md) — the token never leaves the server, no upstream text in the browser, one writer per header, `pnpm audit --prod` and the image and secret scans gate CI
- [Errors and logging](.ai/rules/errors-and-logging.md) — `ActionResult`, `reportError` and the incident id, stable event names, and what is never logged
- [Accessibility](.ai/rules/accessibility.md) — strict `jsx-a11y`, axe in both themes, the token contrast test, and LHCI at `minScore: 1`
- [Performance](.ai/rules/performance.md) — per-route bundle budgets, why raising one needs a written reason, and the Lighthouse resource ceilings
- [Workflow](.ai/rules/workflow.md) — `pnpm check`, the CI jobs, TypeScript strictness, commit style, deployment, dates

## Commands

`/plan` · `/audit` · `/audit-scatter` · `/audit-security` · `/bugfix` · `/refactor` — these
are registered as user-level skills and apply here unchanged. There is no `.ai/commands/` in
this repo.

## Critical rules (excerpt)

Full set in [`.ai/rules/`](.ai/rules/). The ones an agent trips over first:

- **`pnpm check` is the gate** — `format:check && lint && typecheck && codegen:check && cursor:check && knip && test:coverage`. Run it before saying anything is done. Six of the seven also run in CI; `cursor:check` does not, so an `AGENTS.md` edit needs `pnpm cursor:generate` locally or `.cursor/rules/main.mdc` goes stale with CI green.
- **Never log** a token, `Error.cause`, an email, the sealed cookie, or container stdout, and never render upstream failure text — route it through `reportError`. `no-console` across `src/**` is part of this rather than a style rule: a stray `console.error(error)` is how a live access token reached stdout once. Do not disable it.
- **`src/components/**` and `src/hooks/**` may not import** `lib/auth/session|refresh|server` or `lib/logger` / `lib/log/*`. Pass what the component needs as a prop.
- **Every tuned number goes in `src/lib/constants.ts`**, in its group, with a rationale comment.
- **The app only acts on services it created** — the `MANAGED_PREFIX` name check in `src/lib/railway/managed.ts`, tested against Railway's own response, never against client input. It gates every mutating verb, not only destroy. **A volume's owner is its service**, so the same check gates deleting it; destroy asks whether the data goes too and names the outcome either way (ADR-14). **Projects and environments are created but never deleted**, so they carry no prefix and `projectDelete`/`environmentDelete` are absent from `operations.ts` entirely.
- **Coverage gates on how many lines, branches, functions and statements are NOT covered — a count, not a percentage — per directory as well as globally, and knip findings fail CI.** Widening an exclude list is not the fix.
- **Playwright is `workers: 1`** and not negotiable — the fake Railway holds shared state.
- **Raising a bundle budget needs a written reason** in the `$comment` array of `bundle-budgets.json`.
- **A change to the `Dockerfile` is gated by `docker build`, a boot against `/api/health`, hadolint and Trivy** — the `image` job. Run them locally; the commands are in [workflow.md](.ai/rules/workflow.md). Do not put a package manager back into the runtime stage.
- **A new CI job must be added to `required`'s `needs`**, or it gates nothing. `src/toolchain.test.ts` fails when the two disagree.
- **Never create a branch** — commit to the branch you are already on. Commit subjects are sentence-case prose, and bodies explain the defect and the rejected alternatives.
