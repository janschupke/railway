import { cn } from "@/lib/utils";

/**
 * A polite announcement region.
 *
 * Two rules, both learned the hard way and both easy to lose when this is written inline:
 *
 * It stays mounted while idle. Injecting the element and its text in the same commit is
 * the classic way to have an announcement dropped — assistive tech watches a live region
 * for changes, and an element that did not exist a moment ago has no changes to report.
 *
 * It carries no `role`. Toast and Banner already claim `role="status"`, and a third
 * source made every status assertion in the e2e suite ambiguous. `aria-live` plus
 * `aria-atomic` announces identically without competing for the role.
 *
 * There were three hand-written copies of this — PendingStatus, rendered twice on the
 * dashboard, and the container list's summary paragraph — which is three chances to get
 * the mounted-while-empty rule wrong.
 */
export function LiveRegion({
  as: Component = "span",
  className,
  children,
  ...props
}: React.ComponentProps<"span"> & {
  /**
   * `p` where the region is a paragraph of its own, `span` inside running text.
   *
   * Typed as this narrow union rather than made generically polymorphic: two tags is
   * the whole requirement, and a generic `as` would drag in the prop-inference
   * machinery that makes such components hard to read for no benefit here. Both share
   * HTMLElement's attribute surface, so one prop type covers them.
   */
  as?: "span" | "p";
}) {
  return (
    <Component
      aria-live="polite"
      aria-atomic="true"
      className={cn(className)}
      {...(props as React.ComponentProps<"p">)}
    >
      {children}
    </Component>
  );
}
