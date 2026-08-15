---
meta:
  updated: 2026-08-13
---

# Performance

## The bundle budget is a hard gate, not a report

`bundle-budgets.json` holds first-load JS per route, gzipped, in kilobytes:

| Route                | Budget |
| -------------------- | ------ |
| `/`                  | 179    |
| `/dashboard`         | 237    |
| `/dashboard/new`     | 225    |
| `/dashboard/billing` | 214    |
| `/_not-found`        | 171    |

**Every route needs an entry**, or the gate silently stops covering new pages — the script
fails on a route it has no number for, which is what makes that true rather than hoped.

`scripts/check-bundle-budget.ts` (`pnpm size`) checks them against
`.next/diagnostics/route-bundle-stats.json` after `pnpm build`, and the `build` job in CI
fails on a miss. Next 16 no longer prints route sizes, so this is the only thing standing
between a stray import and a silently heavier page.

Numbers were seeded from a real build with ~3% headroom — tight enough that a stray import
fails, loose enough that a dependency patch does not.

## Raising a number is a decision with a written reason

Append to the `$comment` array in `bundle-budgets.json`. The existing entries are the model
for what a reason looks like: the measured before and after, what pulled the weight in, and
why it was worth paying. For example, `/dashboard 209 → 215` records that the image field
became a Radix Popover combobox, that replacing the preset chips was expected to pay for it
and did not (because `ThemeToggle` imports `ToggleGroup` from `radix-ui` directly, keeping
that dependency in the graph on every route), and that the measurement was 209.1 kB set at
actual + ~3%.

**"CI failed so I raised the budget" is not a reason.** Find out what grew first.

## A client component in the root layout costs every route

The `/_not-found 146 → 167` entry is the worked example: moving the top bar into the root
layout meant every route carries Radix ToggleGroup and the shared Slot core (~20 kB gzip)
that only `/` and `/dashboard` used to. It was deliberate — a 404 that cannot say which app
it belongs to was the thing being fixed — but it was paid for knowingly.

Before adding `"use client"`, ask whether the interactivity can live lower in the tree.
Prefer a Server Component; see [architecture.md](architecture.md).

`next.config.ts` puts `radix-ui` in `optimizePackageImports` because it is a single barrel
re-exporting every primitive and is not on Next's default list — importing `Tooltip` pulled
the whole package's module graph into the route chunk. Keep new barrel-style dependencies
off the hot path or add them there.

## Lighthouse gates transfer size, and needs a real session

`lighthouserc.cjs` runs against `/` and `/dashboard`. `numberOfRuns: 1` — **one Chrome,
never a pool.**

- `.lighthouseci/cookie` is written by `scripts/lh-auth.ts`, which completes the real OAuth
  round trip against the fake Railway with Playwright. Its absence is **fatal, not a degraded
  mode**: without it the dashboard redirects to the landing page and the run would silently
  measure the same page twice. `pnpm lighthouse` runs `pnpm lh:auth` for you.
- Resource budgets are errors: script 234 kB, stylesheet 12 kB, font 100 kB, total 389 kB.
  They apply to every URL, so they track the worst case, and they cover what `pnpm size`
  cannot — fonts, CSS and the document itself.
- `categories:accessibility` is gated at `minScore: 1` — a perfect score, nothing less.
  `categories:best-practices` and `categories:seo` are **errors** at 0.9. Both are
  deterministic on a fixed page, unlike the performance score, so gating them costs no
  flakiness; they were enforced without being written down anywhere until now.
- `categories:performance` is a **warning** on purpose. Scores swing 10+ points on a shared
  CI runner and a gate that flakes is a gate everyone learns to ignore. Real size regressions
  are caught by the deterministic checks instead.
- `cumulative-layout-shift` is gated at 0.1, because layout stability is stable enough to
  gate on. That is what the skeletons are for — `src/components/dashboard-skeletons.tsx` and
  the `loading.tsx` shells must mirror the real markup's dimensions, or they trade a spinner
  for a shift.
- `maxWaitForLoad: 45000` because the SSE stream never closes and a network-quiet wait would
  hang until timeout.

## Runtime cost is bounded on purpose

The tuned ceilings in `src/lib/constants.ts` are not arbitrary — they exist so one wedged
build cannot pin a connection, a poll and an upstream socket forever. `STREAM.MAX_DURATION_MS`,
`MISSING_POLLS_BEFORE_STOP`, `MAX_BUFFERED_LINES` and `MAX_CONCURRENT_PER_USER` all have a
paragraph explaining what they bound and what happened without them. Read the comment before
changing a value.

`MAX_CONCURRENT_PER_USER` is 4 because the real limit is the **browser's** six connections
per origin over HTTP/1.1, minus the project watcher and one reserved for RSC navigation. It
was 8, which meant the cap that actually applied was the invisible one and a seventh stream
sat on "Connecting…" with nothing on the wire.

## Before you call this done

```sh
pnpm build && pnpm size
```

If the change touches layout, fonts, CSS, or anything on the dashboard's critical path:

```sh
pnpm serve:e2e &   # wait for it to print ready
pnpm lighthouse
```
