<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Railway Freight Loader

One Next.js 16 App Router app, single package, pnpm. A visitor signs into **their own**
Railway account over OIDC, picks a project and environment, and creates or destroys
Docker-image services with live build and deploy logs streamed into the browser. There is no
database, no client store, and the visitor's token never leaves the server.

All detailed rules live in [`.ai/rules/`](.ai/rules/) — the single source of truth. The
reasoning behind each decision lives in [README.md](README.md) (eleven ADRs) and
[SECURITY.md](SECURITY.md) (the OWASP review, the findings, and the accepted risks). Read
the relevant rule before touching auth, the design tokens, the log stream, or a CI gate.

## Rules

- [Architecture](.ai/rules/architecture.md) — RSC reads / Server Actions write / one SSE route, `src/proxy.ts`, the managed-name ownership rule, import boundaries, `src/lib/constants.ts`, `src/env.ts`
- [Design system](.ai/rules/design-system.md) — two token layers (`--rc-*`), the seven-step type scale defined in four files, and the four appearance bans on feature components
- [Internationalisation](.ai/rules/i18n.md) — every string in `messages/en.json`, type-checked keys, `MessageKey` for code that cannot translate itself
- [Testing](.ai/rules/testing.md) — four tiers, colocated, a ratcheted coverage gate, asserted log records, and the fake Railway with its fault injection
- [Security](.ai/rules/security.md) — the token never leaves the server, no upstream text in the browser, one writer per header, `pnpm audit --prod` gates CI
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

- **`pnpm check` is the gate** — `format:check && lint && typecheck && knip && test:coverage`. Run it before saying anything is done.
- **No raw palette colour, type step, hex literal or `-[var(--…)]` in a feature component** — appearance belongs to `src/components/ui/**` or to a token. It is a lint error, not a guideline.
- **No hardcoded user-facing string in JSX** — it goes in `messages/en.json`. Also a lint error.
- **No `console.*` in `src/**`** — use `src/lib/logger.ts`. This is a security ratchet: a stray `console.error(error)` is how a live access token reached stdout once.
- **Never log** a token, `Error.cause`, an email, the sealed cookie, or container stdout. Never render upstream failure text — route it through `reportError`.
- **`src/components/**` and `src/hooks/**` may not import** `lib/auth/session|refresh|server` or `lib/logger` / `lib/log/*`. Pass what the component needs as a prop.
- **Every tuned number goes in `src/lib/constants.ts`**, in its group, with a rationale comment.
- **The app only destroys services it created** — the `MANAGED_PREFIX` name check in `src/lib/railway/managed.ts`, tested against Railway's own response, never against client input.
- **Coverage thresholds sit just under the measured figures, per directory as well as globally, and knip findings fail CI.** Widening an exclude list is not the fix.
- **Playwright is `workers: 1`** and not negotiable — the fake Railway holds shared state.
- **Raising a bundle budget needs a written reason** in the `$comment` array of `bundle-budgets.json`.
- **Never create a branch**; commit subjects are sentence-case prose, and bodies explain the defect and the rejected alternatives.
