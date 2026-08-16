---
meta:
  updated: 2026-08-13
---

# Accessibility

The app commits to WCAG 2.1 AA and gates on it in three independent places. None of them is
a score to nudge — all three are errors.

## The strict `jsx-a11y` rule set runs, and warnings fail

`eslint-config-next` enables only a subset. `eslint.config.mjs` spreads
`jsxA11y.flatConfigs.strict.rules` over `**/*.{jsx,tsx}` on top of it, and `pnpm lint` runs
with `--max-warnings=0`.

One rule is relaxed, with a reason: `label-has-associated-control` is set to
`{ assert: "either", depth: 3 }`, because Radix primitives forward their own semantics and a
wrapping `<label>` around a Radix control is correct even though the rule cannot see the
association. That is the only relaxation, and it is not a precedent — the fix for a
`jsx-a11y` error is the markup, not the config.

Only the _rules_ are spread, not the whole flat config: `eslint-config-next` already
registers the plugin, and registering it twice is a hard config error. The block is scoped to
JSX files for the same reason.

## Three gates, covering different things

| Gate                                             | Runs in           | Catches                                                             |
| ------------------------------------------------ | ----------------- | ------------------------------------------------------------------- |
| `@axe-core/playwright` in `e2e/a11y.spec.ts`     | `pnpm test:e2e`   | real rendered pages, **every state scanned in both themes**         |
| `src/app/contrast.test.ts`                       | `pnpm test`       | every declared token pair, in milliseconds, before a browser starts |
| LHCI `categories:accessibility` at `minScore: 1` | `pnpm lighthouse` | the audits axe does not run, on a production build                  |

Each covers what the others cannot; [docs/frontend.md](../../docs/frontend.md#accessibility)
argues why, with the failures each has caught.

## A new colour token needs a contrast pass in every theme

`src/app/contrast.test.ts` parses `tokens.css`, strips `@media` blocks (a nested `:root`
inside `prefers-color-scheme: light` otherwise folds into the base declarations and silently
makes both themes identical), and asserts:

- 4.5:1 for normal text
- 3:1 for large text and non-text UI boundaries (WCAG 1.4.11)
- 1.4:1 for frozen textless placeholders — not a WCAG number, the floor at which a shape
  still reads as a shape

Add the token to the dark block, the light block **and** the `[data-theme]` overrides. See
[design-system.md](design-system.md).

## Keyboard and motion have their own specs

`e2e/keyboard.spec.ts` and `e2e/motion.spec.ts`. Extend those rather than scattering ad-hoc
assertions into feature specs — a keyboard trap or a missed `prefers-reduced-motion` is a
cross-cutting regression, and keeping the checks in one place is what makes it findable.

`e2e/console.spec.ts` fails on unexpected browser console output, which is where a stray
React a11y warning surfaces.

## Copy is part of this

Every user-facing string is a catalog key ([i18n.md](i18n.md)), and that includes
`aria-label`, `title` and alert text. A hardcoded `aria-label` is both an i18n violation and
an untranslated screen-reader experience.

`role`, `aria-live` and `aria-*` values are excluded from the i18n rule because they are
protocol, not prose — do not confuse the two directions.

## Before you call this done

```sh
pnpm test src/app/contrast.test.ts
pnpm build && pnpm test:e2e e2e/a11y.spec.ts e2e/keyboard.spec.ts e2e/motion.spec.ts
```

The Lighthouse gate needs `.lighthouseci/cookie`; `pnpm lighthouse` produces it via
`pnpm lh:auth` — see [performance.md](performance.md).
