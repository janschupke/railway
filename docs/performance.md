# Performance

The budgets live in [`bundle-budgets.json`](../bundle-budgets.json) and the Lighthouse ceilings
in `lighthouserc.cjs`; neither is restated here, because a number copied into prose goes stale.
The rule for raising one is in [`.ai/rules/performance.md`](../.ai/rules/performance.md). Each
raise carries its reason in the `$comment` array of `bundle-budgets.json`, which is the change
log for what moved and why — read it rather than a summary of it.

## Measuring

Next 16 stopped printing route sizes, so `pnpm size` reads
`.next/diagnostics/route-bundle-stats.json`, gzips each chunk a route loads first, and compares
against `bundle-budgets.json`. Per route, no browser, ~2 seconds.

size-limit cannot express this: Turbopack hashes every chunk name, so its config could only hold
globs, and a glob sums a directory instead of answering "what does /dashboard cost".

Every budget is seeded from a real build with ~3% headroom — tight enough that a stray import
fails, loose enough that a dependency patch does not.

## Constraints a change should not re-break

Three shapes here are the result of measurement, and each looks like an oversight from outside.

- **`ToastProvider` belongs to `dashboard/layout.tsx`, not the root layout.** From the root it
  ships Radix Toast (~12 kB gzip) to the landing page and the 404, neither of which has an
  action to report.
- **The log pane is `next/dynamic`; the destroy dialog's body and the deployment-history panel
  are not.** Radix traps focus in whatever a dialog contains at open time, so a body that has
  not arrived yet traps nothing and Tab walks into the page behind —
  [e2e/keyboard.spec.ts](../e2e/keyboard.spec.ts) is what catches that. For the history panel
  the boundary plus the loading component it needs cost more than the fraction of a kilobyte
  they defer. The log pane's boundary earns itself because Radix ScrollArea sits behind it.
- **The rail yard must not move `/dashboard` or `/_not-found`.** It is its own client boundary
  and costs `/` about 7 kB gzip. If those two ever move for it, that is a defect rather than a
  budget question.

## Lighthouse

LHCI covers what a byte count cannot — fonts, CSS, and the rendered result — on the landing page
**and the authenticated dashboard**, which [scripts/lh-auth.ts](../scripts/lh-auth.ts) reaches by
driving the real OAuth flow against the fake Railway with Playwright.

Accessibility is gated at 100. The performance _score_ is a warning rather than an error,
because it swings on shared CI runners. The resource budgets beside it are deterministic, so
they gate hard.

`numberOfRuns` is 1. One Chrome, never a pool.

---

[Walkthrough](../walkthrough.md) · [Railway Freight Loader](../README.md)
