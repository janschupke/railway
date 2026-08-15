# Design system, i18n and accessibility

What the browser-facing layer is made of and why. The rules an agent must follow before
writing UI are in [`.ai/rules/design-system.md`](../.ai/rules/design-system.md),
[`.ai/rules/i18n.md`](../.ai/rules/i18n.md) and
[`.ai/rules/accessibility.md`](../.ai/rules/accessibility.md); this file carries the reasoning
behind them.

## Tokens

Tokens live in [src/app/tokens.css](../src/app/tokens.css) in two layers: raw ramps, then a
semantic layer (`--rc-canvas`, `--rc-text-muted`, `--rc-state-running`, …) which is the only
thing the UI is allowed to touch. `@theme inline` in `globals.css` maps the semantic layer onto
Tailwind utilities.

> The semantic tokens are named `--rc-*`, not `--color-*`. Mapping
> `--color-accent: var(--color-accent)` is self-referential: Tailwind resolves it to whatever
> `:root` happens to hold, and the theme overrides silently stop applying — the dashboard
> rendered light-theme accents inside dark mode until the namespaces were separated.

Dark is the default, matching Railway's product; light follows `prefers-color-scheme`; an
explicit `[data-theme]` beats both, in either direction. Container-state colours are resolved
through a `data-state-color` attribute, so adding a state means adding a token rather than
editing a lookup table inside a badge.

Primitives in [src/components/ui/](../src/components/ui/) are built on Radix. That buys real
behaviour, not styling: the destroy confirmation gets a focus trap, Escape handling and focus
restore; action feedback moves to an announced toast region; the raw Railway status enum moves
out of a `title` attribute, where keyboard and screen-reader users never saw it.

Appearance is enforced, not just documented. ESLint rejects raw palette utilities
(`bg-emerald-500/10`), hex literals and `[var(--…)]` arbitrary values in any `className` outside
`src/components/ui/**`, because each of those bypasses the semantic layer and with it the light
theme and the contrast test. `src/features/**` is the other exemption, and
[the walkthrough](../walkthrough.md#the-rail-yard-is-decoration) says why.

## Typography

The type scale is seven roles, not a set of sizes: `display`, `title`, `heading`, `body`,
`label`, `caption`, `mono` — plus `badge`, which is a `Text` variant sharing the caption size
rather than a scale step with a token of its own. Sizes and line-heights live in `tokens.css`
and are mapped into Tailwind as `text-<role>` utilities; the `Text` and `Heading` primitives in
[src/components/ui/text.tsx](../src/components/ui/text.tsx) are the only place a weight is
chosen.

Naming them by role rather than size is the point. `text-sm font-medium` says nothing about
whether the next component should match it, and the app had accumulated four different
spellings of "heading" across five files, two page-level `h1`s ten pixels and a weight apart,
and a log pane whose rows carried a line-height its own skeleton did not.

Four files have to agree for a step to work, and three of the failures are silent:

| File           | What it holds                        | If it is missing                               |
| -------------- | ------------------------------------ | ---------------------------------------------- |
| `tokens.css`   | `--type-<role>-size` / `-height`     | the mapping resolves to nothing                |
| `globals.css`  | the `--text-<role>` `@theme` mapping | Tailwind generates no rule; the class is inert |
| `ui/text.tsx`  | the variant and its weight           | the role is unreachable                        |
| `lib/utils.ts` | `TYPE_SCALE` for tailwind-merge      | the class is read as a _colour_ and dropped    |

That last one is the nastiest: out of the box tailwind-merge only knows Tailwind's own
`text-xs … text-9xl`, so an unrecognised `text-caption` is classified as a text colour and
silently removed wherever it shares a `cn()` call with one.
[src/app/type-scale.test.ts](../src/app/type-scale.test.ts) asserts all four agree, and
`src/lib/utils.test.ts` pins the merge behaviour directly.

Like the colour layer, this is enforced rather than documented: `no-restricted-syntax` in
`eslint.config.mjs` rejects a raw `text-sm`, `font-medium`, `tracking-*` or `leading-*` in any
component outside `src/components/ui/**`.

## Busy state

`Button` owns it: `pending` blocks activation, renders a spinner and sets `aria-busy`, and
`pendingLabel` swaps the text. Two details are load-bearing:

- **`disabled` does nothing to a link.** Under `asChild` the primitive renders through Radix
  `Slot`, and a slotted `<a>` ignores `disabled` entirely — it neither dims nor stops responding
  to Enter. The primitive uses `aria-disabled` and cancels the click instead, so no caller has
  to remember. It stays focusable: moving focus to `<body>` mid-action is worse than a focused
  control that declines to act.
- **The label swap is silent.** Assistive tech does not re-read the accessible name of the
  element it is already on, so progress goes through `PendingStatus`, a live region that stays
  mounted while idle — mounting the region and its text together is the classic way to have an
  announcement dropped.

Controls that hand the page to the browser (sign in, sign out, re-authorize) are full document
navigations, so `useFormStatus` and `useTransition` see nothing. They use `useNavigationPending`,
which raises the flag on activation and clears it on `pageshow` — otherwise returning via
bfcache, after declining Railway's consent screen, restores a button that spins forever.

## Loading states

Every wait a user can cause shows something, and which mechanism applies depends on what the
wait replaces.

**Skeletons stand in for content that is about to appear.** The compositions live in
[src/components/dashboard-skeletons.tsx](../src/components/dashboard-skeletons.tsx) and are
shared by the route-level `loading.tsx` and the in-page Suspense fallback, so a placeholder row
is defined once. Two rules there are load-bearing and have tests:

- **They are synchronous and take their strings as props.** A Suspense fallback must not
  suspend; an `async` composition awaiting `getTranslations()` would escalate past its own
  boundary and blank the whole route instead of one section.
- **The container fallback renders no `<ul>`.** The e2e helpers find the list by
  `getByRole("list", { name: "Containers" })` and assert there is exactly one.

**The top bar no longer needs one.** It used to have a skeleton, and keeping it pixel-identical
to the real header was a standing obligation enforced by an exact `boundingBox` comparison.
`AppHeader` now renders in the root layout, above every route's loading boundary, so the same
element survives the transition and there is nothing to stand in for. That test is still there —
it guards the placement decision instead, and passes by construction rather than by two class
strings agreeing.

**The container list sits behind a keyed Suspense boundary.** `page.tsx` awaits only the shell —
identity, projects, the resolved selection — and `ContainerSection` awaits the second Railway
round trip on its own. The `key` is the selection, and it is on `<Suspense>` rather than on the
child, because React only reveals a fallback for a boundary it is _mounting_: an update to a
boundary already showing content suspends without committing, which is precisely why switching
project used to hold the previous project's rows on screen for the whole fetch. Keying the child
compiles, renders and reviews identically while restoring the bug, so
[e2e/skeleton.spec.ts](../e2e/skeleton.spec.ts) asserts the old rows are gone rather than only
that the skeleton appeared.

The same property means `router.refresh()` — same key — never blanks a list the user is reading.
Those call sites carry their own pending state instead: spin-up and destroy wrap the refresh in
`useTransition` so the control that caused it stays busy, and the destroy trigger is inert until
the refreshed list lands, closing a window in which it could be clicked again against a service
that no longer existed. The settle-refresh in `container-row.tsx` deliberately has none — nobody
activated it, several rows can settle at once, and the badge has already updated from the stream.

**The placeholder fill is a token, not an animation.** `globals.css` freezes every animation
under `prefers-reduced-motion`, so `--rc-subtle` at ~1.05:1 was an invisible rectangle for those
users. `--rc-skeleton` sits at ~1.5:1 dark / ~1.45:1 light, asserted in `contrast.test.ts`, and
the pulse is `motion-safe:` — an enhancement, not the signal. The mid-load axe scan runs with
reduced motion forced, which is exactly the state the token exists for.

## Internationalisation

Every user-facing string lives in `messages/en.json`. Components read it through next-intl:
`getTranslations` on the server, `useTranslations` on the client.

There is one locale, and that is a stopping point rather than an unfinished job — adding a second
is a translation task, not a refactor. Three things make that claim real rather than
aspirational:

- **`no-literal-string` (eslint-plugin-i18next)** on `src/**/*.tsx`. A hardcoded sentence fails
  the build. Without it the catalog decays on the next commit.
- **Typed keys.** `global.d.ts` declares the catalog as next-intl's `Messages`, so
  `t("dashboard.emptyTitle")` is checked by `tsc`. A renamed key breaks the build instead of
  rendering a missing-message marker.
- **Tests assert real copy.** The Vitest setup swaps next-intl's hooks for its own
  `createTranslator` over the actual `en.json`, so a misnamed ICU argument or a malformed plural
  fails a component test. A key-echoing stub would have hidden all of it.

Code that has no request scope — error classes, the log monitor — returns a `MessageDescriptor`
(`{ key, values }`) instead of a sentence, and the layer that renders resolves it. That is what
keeps a Railway failure one catalog key rather than English frozen inside a `throw`.

Some cases needed more than a placeholder: `{managed} of {total} created here` is an ICU plural,
the managed-prefix note is rich text with a `<code>` chunk that translators can move, and
`relativeTime` uses `Intl.RelativeTimeFormat` — the previous `${n}s ago` was plural-blind and
assumed the marker was a suffix, which it is not in German.

## Accessibility

WCAG 2.1 AA, checked three ways because each misses what the others catch:

1. **`@axe-core/playwright`** on every meaningful state — landing, dashboard populated and empty,
   destroy dialog, log panel, form errors — **in both themes**.
2. **[src/app/contrast.test.ts](../src/app/contrast.test.ts)** parses `tokens.css` and computes
   the contrast ratio of every declared pair in both themes. It runs in milliseconds without a
   browser and covers colours no spec happens to visit; it is what makes promising two themes
   safe. It has already caught four real failures, and it also reads the rail yard's own token
   list, so a colour the canvas asks for that `tokens.css` does not declare fails here.
3. **Keyboard specs** ([e2e/keyboard.spec.ts](../e2e/keyboard.spec.ts)) for focus traps, focus
   restore, roving tabindex, Escape and live-region politeness. Axe cannot see any of that — and
   they are what make replacing a native `<select>` with a Radix one defensible.

Axe misses more than timing. The unmanaged-container control passed every scan while showing
"Not managed here" under an accessible name of "Why can't postgres be destroyed?" — no shared
words, so voice control could not address the thing on screen (WCAG 2.5.3 Label in Name). Nothing
automated flagged it.

Plus `eslint-plugin-jsx-a11y` at strict, with CI failing on any warning.

---

[Walkthrough](../walkthrough.md) · [Railway Freight Loader](../README.md)
