import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Placeholder fill.
 *
 * The colour, not the motion, is what makes this read as a skeleton: globals.css
 * freezes every animation under `prefers-reduced-motion`, so a pulse-only placeholder
 * would be an invisible rectangle for anyone who asked for less movement. `motion-safe:`
 * states that outright — the animation is the enhancement, `--rc-skeleton` is the signal.
 *
 * `shape` mirrors the radii of the real controls, so a composition can say what it is
 * standing in for instead of repeating `rounded-md` at every call site.
 */
const skeletonVariants = cva("bg-skeleton motion-safe:animate-pulse", {
  variants: {
    shape: {
      block: "rounded", // text and small fills
      control: "rounded-md", // Button, Select trigger
      panel: "rounded-lg", // Card
      pill: "rounded-full", // StatusBadge
    },
  },
  defaultVariants: { shape: "block" },
});

type SkeletonProps = React.ComponentProps<"div"> &
  VariantProps<typeof skeletonVariants>;

export function Skeleton({ shape, className, ...props }: SkeletonProps) {
  return (
    <div
      // Decorative: the surrounding region carries aria-busy.
      aria-hidden
      className={cn(skeletonVariants({ shape }), className)}
      {...props}
    />
  );
}
