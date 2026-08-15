---
meta:
  updated: 2026-08-13
---

# Design system

## Tokens come in two layers, and only the second one is usable

`src/app/tokens.css`:

1. **Primitives** — raw ramps (`--plum-900`, `--violet-500`, `--gray-400`). Never
   referenced outside that file.
2. **Semantic** — `--rc-*`. What the UI is allowed to use.

`src/app/globals.css` maps the semantic layer into Tailwind with `@theme inline`
(`--color-surface: var(--rc-surface)`). Only the semantic layer is exposed, so
`bg-plum-900` deliberately does not exist as a utility.

**Semantic tokens are named `--rc-*`, not `--color-*`.** Tailwind's `@theme` maps them onto
its own `--color-*` variables; using the same name on both sides makes the mapping
self-referential and the theme overrides silently stop applying.

Adding a colour is three edits: the primitive (if the ramp does not already have it), the
`--rc-*` semantic token in every theme block, and the `@theme inline` mapping. Miss the
mapping and Tailwind generates nothing — the class lands in the markup, matches no rule, and
the element renders whatever it inherited. That failure is invisible in review.

## Feature components may not write appearance

`eslint.config.mjs` bans four things in `src/**/*.tsx`, with `src/components/ui/**` as the
only exemption. Each is an error, not a warning, and `pnpm lint` runs with
`--max-warnings=0`.

| Banned in a `className`                                                 | What to do instead                                                           |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Raw type step — `text-sm`, `font-medium`, `tracking-tight`, `leading-6` | `<Text variant=…>` or `<Heading>` from `src/components/ui/text.tsx`          |
| Raw palette colour — `bg-emerald-500/10`, `text-gray-400`               | A semantic token: `bg-surface`, `text-text-muted`, `border-danger-border`    |
| Hex literal — `#6c3fe7`                                                 | Add a semantic token in `tokens.css`, map it in `globals.css`                |
| `-[var(--…)]` — `fill-[var(--rc-raised)]`                               | Map the token in `globals.css` and use the generated utility (`fill-raised`) |

The scale roles (`text-body`, `text-caption`, …) are deliberately _not_ matched by the type
rule — those come from the tokens and are what to reach for on the rare element no primitive
wraps.

**The correct fix is never to move the file out of scope or widen the ignore list.** If a
feature component genuinely needs a new appearance, the appearance belongs in a primitive
under `src/components/ui/` or in a new token.

This is a ratchet: nothing violates it today. It exists because the drift has already
happened once — before the `Text` primitive there were four spellings of "heading" across
five files, and the two page-level `h1`s were ten pixels and a weight apart.

## The type scale is defined in four files that must agree

Seven variants: `display`, `title`, `heading`, `body`, `label`, `caption`, `mono`. (`badge`
is a `Text` variant too, but it shares the caption size deliberately and has no token of its
own.)

Each has to be declared in all four places or it half-exists:

1. `src/app/tokens.css` — `--type-<v>-size` and `--type-<v>-height`
2. `src/app/globals.css` — `--text-<v>` and `--text-<v>--line-height` under `@theme inline`
3. `src/components/ui/text.tsx` — the variant
4. `TYPE_SCALE` in `src/lib/utils.ts` — otherwise tailwind-merge classifies the step as a
   text _colour_ and silently drops it wherever it shares a `cn()` call with one

`src/app/type-scale.test.ts` asserts all four by reading the source files. It also asserts
that no `--font-weight-*` token exists: `--font-weight-display` and `--font-display` both
generate `font-display` in Tailwind v4, the weight wins, and Inter Tight silently disappears
from every heading. **Weight lives in the `Text` primitive for that reason.**

## Primitives, variants, merging

- Primitives live in `src/components/ui/` and wrap Radix from the single `radix-ui` barrel.
  `next.config.ts` puts `radix-ui` in `optimizePackageImports` because the barrel otherwise
  pulls the whole package graph into a route chunk.
- Variants are `cva`. Class merging is `cn()` from `src/lib/utils.ts` — a `tailwind-merge`
  instance extended with `TYPE_SCALE`, never bare `clsx` or string concatenation.
- Control geometry (`h-control-*`, `px-control-*`) is tokenised too, and asserted by
  `src/app/control-scale.test.ts`. Do not hand-size a button.
- Check `src/components/ui/` before writing a component. **Read the directory rather than
  this list** — it went stale by ten entries once already, which is the worst way for a
  "check before you build" instruction to fail: it sends a reader off to write a checkbox
  that exists. As of 2026-08-15: alert dialog, banner, button, card, checkbox, chip,
  combobox, dialog, disclosure, error block, field, input, key-value editor, live region,
  misc, multi-select, page, scroll area, select, skeleton, text, theme toggle, toast and
  tooltip.

## Three themes, not two

Dark is the default (matching Railway's own product). Light is served to anyone whose OS
asks via `prefers-color-scheme`. An explicit `[data-theme]` on `<html>` overrides **both**
directions.

A new `--rc-*` token needs a value in every block. Miss one and the element renders
transparent or inherits — and `src/app/contrast.test.ts` will fail, because it parses
`tokens.css` and computes the ratio for every text-on-background pair. See
[accessibility.md](accessibility.md).

## Before you call this done

The lint rules catch the four bans, so `pnpm lint` is the real check. To see the ratchet's
current state:

```sh
pnpm lint
pnpm test src/app/type-scale.test.ts src/app/contrast.test.ts src/app/control-scale.test.ts
```
