import Link from "next/link";
import { cva } from "class-variance-authority";

/**
 * A row of routed tabs.
 *
 * **Links with `aria-current`, deliberately not `role="tablist"`.** That role promises the
 * ARIA authoring-practices pattern — roving arrow-key focus, and `aria-controls` naming a
 * `tabpanel` that exists in the same document — and neither is true here. The panel *is* a
 * route: it does not exist until the server answers, so `aria-controls` would point at
 * nothing for the length of every transition, and a screen reader announcing "tab 2 of 3,
 * selected" a beat before a full navigation is a promise the markup cannot keep.
 *
 * These are URLs on purpose. Each of the three views is meant to be bookmarkable and
 * shareable, and a link is what makes middle-click, ctrl-click and the back button behave.
 * A `<button role="tab">` is none of those.
 *
 * Radix Tabs was the obvious alternative and is not in the graph: it would add a roving
 * focus model to every dashboard route in exchange for a keyboard behaviour that then has
 * to be fought into navigating. `next/link` is already here via app-header.tsx.
 * e2e/keyboard.spec.ts pins the resulting model — Tab moves between them, not Arrow.
 */
const tab = cva(
  [
    "focus-ring text-body inline-flex items-center rounded-t-md border-b-2 px-3 py-2",
    "transition-colors",
  ].join(" "),
  {
    variants: {
      /**
       * Whether this tab is the route currently rendered.
       *
       * The on-state colours are the ones `ui/chip.tsx` already uses for a selected
       * filter, so the two selection affordances in the dashboard agree rather than each
       * choosing an accent. Nothing new is declared, so contrast.test.ts is untouched.
       */
      current: {
        true: "border-accent text-accent",
        false: "hover:text-text hover:border-border border-transparent text-text-muted",
      },
    },
    defaultVariants: { current: false },
  },
);

/*
 * Bound here rather than written inline, for the reason project-picker.tsx states about
 * its own discriminants: the i18n rule reads every string literal in JSX as user-facing
 * copy, and it does not exempt `aria-current` on a *component* the way it does on a bare
 * DOM element. This is a platform enum value, not prose — and widening the allowlist is
 * the fix .ai/rules/i18n.md explicitly refuses.
 */
const CURRENT_PAGE = "page";

export type TabItem = {
  href: string;
  label: string;
  current: boolean;
};

export function TabNav({ label, items }: { label: string; items: TabItem[] }) {
  return (
    <nav aria-label={label}>
      {/*
        The <ul> carries NO accessible name, and that is load-bearing rather than an
        omission. e2e/support.ts finds the container list with
        getByRole("list", { name: "Containers" }) and asserts exactly one match; a labelled
        list here would be a second one and break every container spec at once, with a
        strict-mode error naming neither cause. The <nav> is what gets the name.
      */}
      <ul className="flex flex-wrap items-center gap-1">
        {items.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              /*
               * Default prefetch would fire an RSC render of the other two tabs the moment
               * this strip enters the viewport — which it does immediately, since it sits
               * under the header. Each of those is a `listProjects` against Railway, and
               * the spin-up tab is a container read on top. The trade is a slower first
               * switch in exchange for making no upstream request nobody asked for.
               */
              prefetch={false}
              aria-current={item.current ? CURRENT_PAGE : undefined}
              className={tab({ current: item.current })}
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
