import { cva } from "class-variance-authority";

/**
 * The pill recipe, in one place.
 *
 * `rounded-full px-2 py-0.5` was written out twice — the status badge and the status
 * filter toggles — which is the same drift the Text primitive exists to prevent, on a
 * different axis: two pills sitting on the same row, kept the same size by nobody. The
 * filter chips are meant to read as the badges they filter, and that relationship was
 * carried entirely by the two class strings happening to match.
 *
 * Exported as a recipe rather than a component. Both call sites already wrap their
 * content in something else — `Text asChild` around a Radix ToggleGroup.Item, and `Text`
 * with a data attribute — so a third element in that stack would buy nothing.
 *
 * The theme toggle is deliberately NOT a caller. It is square, icon-only and sized from
 * the control tokens; it shares only the idea of "a toggle", and folding it in would mean
 * a shape variant that exists for one user.
 */
export const chip = cva("inline-flex items-center rounded-full px-2 py-0.5", {
  variants: {
    /**
     * Whether the pill is a control.
     *
     * `selectable` carries the whole affordance — focus ring, cursor, hover, and the
     * data-[state=on] treatment Radix ToggleGroup applies. A static badge takes its
     * colour from `data-state-color` instead and must not carry any of it.
     */
    selectable: {
      true: [
        "focus-ring border-border text-text-muted cursor-pointer border transition-colors",
        "hover:bg-subtle hover:text-text",
        "data-[state=on]:border-accent data-[state=on]:bg-accent-bg data-[state=on]:text-accent",
      ].join(" "),
      false: "",
    },
    /** Room for a leading dot or icon. */
    gap: { none: "", dot: "gap-1.5" },
  },
  defaultVariants: { selectable: false, gap: "none" },
});
