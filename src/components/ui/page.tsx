import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * The content column, in one place.
 *
 * Seven files hand-wrote a variant of `mx-auto w-full max-w-… flex-1 … p-6`, and two of
 * them were byte-identical — the dashboard page and its own loading state, which are
 * exactly the pair that must not drift, since one is the placeholder for the other.
 *
 * Two recipes rather than one: the routes render a `<main>` that grows to fill the page,
 * and the header and footer render a bar that does not. They share only the centring and
 * the max width, which is what `column` carries.
 */
const column = cva("mx-auto w-full", {
  variants: {
    width: {
      /** Reading column: the sign-in card and the 404. A form at 56rem reads as empty. */
      narrow: "max-w-md",
      /** The app proper, and the chrome that has to line up with it. */
      wide: "max-w-4xl",
    },
    layout: {
      /** Stacked content that starts at the top. */
      stack: "space-y-6",
      /** Centred vertically in whatever height is left — an error or an empty state. */
      centre: "flex items-center",
      /** A column of cards, centred, as on the landing page. */
      hero: "flex flex-col justify-center gap-4",
      /** A horizontal bar. */
      bar: "flex items-center justify-between gap-4",
    },
    pad: { page: "p-6", bar: "px-6 py-3" },
  },
  defaultVariants: { width: "wide", layout: "stack", pad: "page" },
});

/**
 * The id the skip link targets.
 *
 * Owned here rather than written per route, because a skip link pointing at an id that
 * one page forgot is worse than no skip link: it reports success to a keyboard user and
 * moves focus nowhere.
 */
const MAIN_ID = "main";

/**
 * A route's content column.
 *
 * `flex-1` is not a variant — every page needs it, because <body> is a min-height flex
 * column and the footer's placement depends on the main region growing.
 */
export function PageMain({
  className,
  width,
  layout,
  pad,
  ...props
}: React.ComponentProps<"main"> & VariantProps<typeof column>) {
  return (
    <main
      id={MAIN_ID}
      /*
       * Focusable only as a fragment target, never in the tab order.
       *
       * Without it the skip link is decorative: following a fragment link moves the
       * browser's sequential-focus starting point but leaves document.activeElement on
       * <body>, so the next Tab resumes from the top of the header — which is the very
       * thing the link exists to skip. -1 makes focus actually land here while keeping
       * <main> out of the tab sequence for everyone else.
       */
      tabIndex={-1}
      className={cn(
        column({ width, layout, pad }),
        // No focus ring: focus arrives here programmatically, and a ring around the
        // whole page reads as an error rather than as an anchor.
        "flex-1 outline-none",
        className,
      )}
      {...props}
    />
  );
}

/** The inner column of the header and footer bars, which line up with PageMain. */
export function BarInner({
  className,
  width,
  layout,
  pad,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof column>) {
  return (
    <div
      className={cn(column({ width, layout, pad: pad ?? "bar" }), className)}
      {...props}
    />
  );
}

/**
 * "Skip to content", visible only while focused.
 *
 * `sr-only` until `focus:not-sr-only`, which is the standard shape: it costs sighted
 * users nothing and appears the moment a keyboard user reaches it. Positioned fixed so
 * revealing it does not reflow the header underneath.
 */
export function SkipLink({ label }: { label: string }) {
  return (
    <a
      href={`#${MAIN_ID}`}
      className="focus-ring bg-surface text-text border-border focus:z-overlay sr-only rounded-md border px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
    >
      {label}
    </a>
  );
}
