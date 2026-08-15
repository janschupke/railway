# Performance

The budgets themselves live in [`bundle-budgets.json`](../bundle-budgets.json) and the
Lighthouse ceilings in `lighthouserc.cjs`; neither is restated here, because a number copied
into prose is a number that goes stale. The rule for raising one is in
[`.ai/rules/performance.md`](../.ai/rules/performance.md). What follows is how it is measured
and what moved.

## Measuring

Next 16 stopped printing route sizes, so `pnpm size` reads
`.next/diagnostics/route-bundle-stats.json`, gzips each chunk a route loads first, and compares
against `bundle-budgets.json`. Per route, no browser, ~2 seconds.

size-limit cannot express this: Turbopack hashes every chunk name, so its config could only hold
globs, and a glob sums a directory instead of answering "what does /dashboard cost".

Every budget is seeded from a real build with ~3% headroom — tight enough that a stray import
fails, loose enough that a dependency patch does not — and every raise carries its reason in the
`$comment` array of the same file. That array is the change log for this section; read it rather
than a summary of it.

## What moved the numbers

- **`ToastProvider` moved from the root layout to `dashboard/layout.tsx`.** The landing page and
  the 404 were shipping Radix Toast — ~12 kB gzip — to render UI with no actions.
- **The log pane is `next/dynamic`.** It only mounts once a row is expanded, and it brings Radix
  ScrollArea with it.
- **The 404 pays for the shared top bar.** `ThemeToggle` is a client component, so every route
  now carries Radix ToggleGroup and the shared Slot core once the header moved into the root
  layout. That bought the landing page a header it did not have and the 404 a `<main>` and a
  width.
- **The rail yard cost `/` about 7 kB gzip and no new dependency**, and deliberately did not move
  `/dashboard` or `/_not-found`, because it is its own client boundary. If those two ever move
  for it, that is a defect and not a budget question.

Two that looked obvious and were reverted:

- **Lazy-loading the destroy dialog's body.** It saved ~10 kB on paper, but Radix traps focus in
  whatever the dialog contains when it opens — and for the tick before the chunk arrived, that was
  nothing, so Tab walked straight out into the page behind.
  [e2e/keyboard.spec.ts](../e2e/keyboard.spec.ts) caught it. Removing the `next/dynamic` wrapper
  also made the route _smaller_, because the wrapper cost more than the split saved.
- **A second dynamic boundary around the deployment-history panel.** The component genuinely
  left `/dashboard`'s first load, checked against `route-bundle-stats.json` rather than assumed —
  and the route got bigger. A dynamic boundary plus the loading component the panel needs to avoid
  a two-step reflow costs more than the fraction of a kilobyte it defers. LogPane's boundary earns
  itself because Radix ScrollArea sits behind it; there is nothing of that size behind this one.

## Lighthouse

LHCI covers what a byte count cannot — fonts, CSS, and the rendered result — on the landing page
**and the authenticated dashboard**, which [scripts/lh-auth.ts](../scripts/lh-auth.ts) reaches by
driving the real OAuth flow against the fake Railway with Playwright.

Accessibility is gated at 100. The performance _score_ is a warning, because it swings on shared
CI runners and a gate that flakes is a gate everyone learns to ignore. The resource budgets beside
it are deterministic, so they gate hard.

`numberOfRuns` is 1. One Chrome, never a pool.

---

[Walkthrough](../walkthrough.md) · [Railway Freight Loader](../README.md)
