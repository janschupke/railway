---
meta:
  updated: 2026-08-13
---

# Testing

## Four tiers, and a change belongs in one of them

`vitest.config.mts` defines three Vitest projects; Playwright is the fourth tier.

| Tier          | Files                          | Environment | Use it for                                                         |
| ------------- | ------------------------------ | ----------- | ------------------------------------------------------------------ |
| `unit`        | `src/**/*.test.ts`             | node        | `src/lib/**`, pure logic, serializers, the session layer           |
| `component`   | `src/**/*.test.tsx`            | jsdom       | anything in `src/components` and `src/hooks`, including async RSCs |
| `integration` | `src/**/*.integration.test.ts` | node        | route handlers and Server Actions against MSW-backed HTTP          |
| `e2e`         | `e2e/*.spec.ts`                | chromium    | the real browser: navigation, streaming, keyboard, a11y, CSP       |

**Tests are colocated** next to the source they cover — `src/lib/sse.ts` ↔
`src/lib/sse.test.ts`. There is no `__tests__` directory and no mirrored tree.

The component project loads `setup-intl` as well as `setup-dom`, which is what lets an async
Server Component be rendered by awaiting it. The two are additive: `setup-dom` mocks
`next-intl` for client components, `setup-intl` mocks `next-intl/server`.

## Coverage is a ratchet, not a floor, and the exclude list is not a lever

`include: ["src/**"]`. Thresholds are **counts of what is not covered**, not percentages —
a negative number in `vitest.config.mts` means "at most this many uncovered", and each sits
about a tenth above the measured figure. There are per-directory floors for `src/lib/**`,
`src/hooks/**`, `src/features/**` and `src/components/**` as well as the global four. A
miss fails `pnpm test:coverage`, which fails `pnpm check` and CI, and it names the count:
`Uncovered lines (81) exceed global threshold (75)`.

**Counts rather than percentages, because a percentage measures the wrong thing here.** Its
denominator moves with the code, so the gate changes meaning when nothing about the testing
has. Adding a well-tested module can fail a percentage that a smaller and worse-tested tree
passed — the global lines gate had about thirteen uncovered lines of headroom, so a new
forty-line module with twenty-five covered lines was a red build however well it was tested
— and deleting code silently loosens it. A count says what the ratchet has always meant:
this many lines in the app are not exercised, and the number may go down. It also survives a
refactor that only moves code between files, which a per-directory percentage does not.

Both halves of that matter, and both were once wrong. The thresholds were 80 against an
actual of ~94, so a change could delete a third of the branch coverage and still pass —
the gate stated an intention rather than defending one. And a global aggregate cannot see
one file at zero: five modules had no test at all while the headline read 94, including
`lib/railway/subscribe.ts`, the upstream WebSocket. `perFile: true` is the obvious answer
and the wrong one — it fails on legitimately thin modules like `i18n/config.ts`, and its
only remedy is widening the exclude list, which is precisely what this section forbids.

**The set of floors has to be complete, or the aggregate is back.** `src/components/**` was
missing from it and measured 95.65 / 89.94 / 95.74 / 96.70 — under the _global_ gate on all
four axes, passing only because `src/features` and `src/hooks` sit near 99 and carry the
mean. That is the paragraph above happening again, one directory over, and nothing
distinguished a directory left out on purpose from one left out by accident. A new
top-level directory under `src/` needs a floor in the same commit that creates it.

**A directory floor did not save `subscribe.ts` either**, which is worth knowing before
reaching for one as the answer to a single thin module. It is the file named above as the
reason the floors were added, and it still read 33% functions afterwards: `src/lib/**`
aggregates forty-odd files, so a fifteen-line module cannot move that mean any more than it
could move the global one. It now carries a **file-level** threshold at 100 — the only one
in the config — because it is small enough for that to cost nothing and it is the single
place in the app that puts a bearer token on an upgrade request. Reach for a file entry
when the module is both small and load-bearing; the directory floor is for everything else.

When the real number falls, lower these — a count goes down as coverage goes up, which is
the direction the ratchet turns. Raising one is the same class of edit as raising a bundle
budget: permitted, and argued for in the commit that does it.

Excluded: `src/test/**`, `*.d.ts`, `*.test.*`, and the framework shells — `layout.tsx`,
`page.tsx`, `loading.tsx`, `error.tsx`, `not-found.tsx`. Those are React Server Components
and route boundaries whose behaviour is composition; Playwright covers them end to end, and
Playwright does not feed this number. Counting them here would either inflate the figure or
invite render tests that assert nothing.

Everything with logic in it — `lib`, `hooks`, `components`, Server Actions, data loaders,
API route handlers — is inside the gate. **Widening the exclude list to pass is not an
option**; write the test.

## Log records are asserted, not printed past

`src/test/setup.ts` installs `src/test/log-capture.ts` globally and sets `LOG_LEVEL=debug` —
`debug`, not `silent`, because two suites were writing real error output to stdout during
`pnpm test` and nobody noticed. The capture passes non-log writes through so the terminal
stays readable.

Use it:

- `logRecords()` — parsed records, for asserting an event name and its fields.
- `rawLogLines()` — the unparsed lines, for **credential canaries**. There is already one
  over the real OAuth callback asserting no token text ever reaches stdout. If you touch
  anything on a token path, add one.

`src/test/log-capture.ts` deliberately imports nothing from `src/lib`: `knip.jsonc` ignores
`src/test/**`, so an import from there does not register as usage and would report the
imported symbol as dead code. The trade is the one literal it has to keep in sync with
`logger.ts`'s `base.service`.

## Tests assert real copy, through the real translator

`src/test/setup-intl.ts` wires next-intl's own `createTranslator` over `messages/en.json`.
So a test fails if a key is missing from the catalog, if an ICU argument is misnamed, or if a
plural form is malformed — none of which a key-echoing stub would notice.

Assert the rendered sentence. Do not assert `"containers.destroyed"`.

## Playwright is `workers: 1`, and that is not negotiable

`playwright.config.ts` sets `workers: 1` and `fullyParallel: false`. The fake Railway holds
shared in-memory state and the suite resets it between specs, so parallel workers race. It
also keeps a browser pool off developer machines.

Two projects, and the split is deliberate: `chromium` runs everything except
`responsive.spec.ts`, and `mobile` (Pixel 7) runs only that one. A second full project would
roughly double CI wall-clock at `workers: 1` and buy very little — the app reaches for `sm:` four times
in all of `src/` and adapts by wrapping everywhere else, so there is no viewport-conditional
code for a second pass to regress. Put a phone-width assertion in `e2e/responsive.spec.ts`
rather than adding a project.

Run the suite as one invocation — `pnpm test:e2e`. Do not add workers, do not add browsers,
do not shard.

## The fake Railway is the test double, and it can fail on demand

`e2e/fixtures/fake-railway/` signs real RS256 OIDC with a JWKS endpoint, serves GraphQL over
an in-memory store, and speaks hand-rolled `graphql-transport-ws`. The app runs unmodified
against it, so PKCE, token exchange and refresh rotation are all genuinely exercised.

- Every spec resets it: the `test` fixture in `e2e/support.ts` posts to `/__test/reset`
  before the page is used.
- Failures are injected, not waited for: `injectFaults(page, {…})` posts to `/__test/faults`
  and supports twenty-seven knobs — `rateLimit`, `unauthorized`, `refreshFails`,
  `accessTokenTtl`, `deploymentsFail`, `logPhase`, `failureField`, `deploymentEventsFail`,
  `deploymentListFail`,
  `variablesFail`, `domainFails`, `settingsFail`, `limitsFail`, `volumeCreateFail`,
  `volumesFail`, `metricsFail`, `workspaceFail`, `noWorkspace`, `projectsSource`,
  `rejectWorkspaces`, `rejectPersonal`, `projectsEmpty`, `slowMs` and `registryStatus`.
  `Faults` in `store.ts` is the list; this one is a summary and will drift again.
- `fixtureStats(page)` exposes grant counters, because refresh happens server-side and
  Playwright cannot observe it with `waitForRequest`.

**Prefer a fault or a stats assertion over a sleep.** A `slowMs` fault makes a pending state
observable deterministically; a `waitForTimeout` makes it observable sometimes.

The one exemption is asserting an **absence**, which has no event to await. `console.spec.ts`
waits for the engine to emit an unused-preload warning that may never come; `watch.spec.ts`
waits out a poll interval to show that nothing was polled. Both are bounded, and both are
written as "quiet for N, ceiling at M" or "two intervals of the thing being tested" rather
than as a round number chosen to feel safe. A window picked to be comfortably larger than
the behaviour under test is how `watch.spec.ts` stayed green for the whole time
`WATCH_POLL_MS` was being ignored.

Never point a test at the real Railway API.

## Before you call this done

```sh
pnpm test:coverage
```

and, if the change is reachable from the browser:

```sh
pnpm build && pnpm test:e2e
```

A single spec is `pnpm test:e2e e2e/containers.spec.ts`; a single Vitest file is
`pnpm test src/lib/sse.test.ts` — positional filters, no `--`, which Vitest would otherwise
swallow and run the whole suite.

`pnpm build` is not optional in that line. `playwright.config.ts` starts
`node .next/standalone/server.js` — a file `next build` writes and nothing else does, so
without a build the suite either cannot start or, worse, serves the last one. Nothing warns:
an old build passes, and the change under test is simply not in it.

Both webservers reuse an existing one outside CI, so a dev server already on 3100 or a
fixture on 4010 will be adopted rather than replaced. On 3100 that is now the same trap
wearing a different hat — a `next dev` there is adopted, and the suite runs against dev.
