<!--
The same standard the commit body holds to: the outcome and the reasoning, not a
restatement of the diff. If an alternative was rejected, name it and why.
-->

## What changed

## Why

## Gates

`pnpm check` is the local gate — `format:check`, `lint` at zero warnings, `typecheck`,
`codegen:check`, `knip`, and `test:coverage` against the thresholds in `vitest.config.mts`.
Nothing is ready before it passes.

- [ ] `pnpm check`

CI runs five more that `pnpm check` does not. Tick the ones this change can reach and you
ran locally; CI runs all five regardless, and **All checks** — the `required` aggregator —
is the single name branch protection requires.

- [ ] `pnpm build && pnpm size` — per-route first-load JS against `bundle-budgets.json`
- [ ] `pnpm test:e2e` — Playwright against the fake Railway fixture, workers: 1
- [ ] `pnpm lighthouse` — LHCI scores and resource budgets, one Chrome
- [ ] `pnpm verify:schema` — pinned OIDC metadata against Railway's discovery document
- [ ] `docker build` — the deployment image, then boot it and check `/api/health`; hadolint
      and Trivy over it. The commands are in `.ai/rules/workflow.md`. **Tick this one for
      any change to the `Dockerfile`** — it is the only gate that runs what deploys.

The secret scan needs nothing from you: gitleaks reads the whole history on every run.
