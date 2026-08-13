import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * How far off its background the card sits.
 *
 * A variant rather than a `shadow-*` at the call site: the elevation scale is the
 * primitive's to own, and a caller reaching for a Tailwind step is how two cards on the
 * same page end up a shadow apart for no stated reason.
 */
const cardVariants = cva("border-border bg-surface rounded-lg border", {
  variants: {
    elevation: {
      /** In the page's own plane. The dashboard's panels, which tile against each other. */
      flat: "shadow-sm",
      /**
       * Above whatever is behind it. The sign-in card stands on the animated freight
       * yard, and at `flat` the two read as one surface.
       */
      raised: "shadow-md",
    },
  },
  defaultVariants: { elevation: "flat" },
});

type CardProps = React.ComponentProps<"div"> & VariantProps<typeof cardVariants>;

export function Card({ elevation, className, ...props }: CardProps) {
  return <div className={cn(cardVariants({ elevation }), className)} {...props} />;
}
