import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const bannerVariants = cva("rounded-md px-3 py-2 text-sm", {
  variants: {
    tone: {
      error: "bg-danger-bg text-danger",
      success: "bg-success-bg text-success",
      warning: "bg-warning-bg text-warning",
      info: "bg-subtle text-text-muted",
    },
  },
  defaultVariants: { tone: "info" },
});

type BannerProps = React.ComponentProps<"p"> & VariantProps<typeof bannerVariants>;

/**
 * Inline, persistent message tied to a region of the page. Transient feedback about an
 * action the user just took belongs in a Toast instead.
 */
export function Banner({ tone, className, ...props }: BannerProps) {
  return (
    <p
      // Errors interrupt; everything else is announced politely.
      role={tone === "error" ? "alert" : "status"}
      className={cn(bannerVariants({ tone }), className)}
      {...props}
    />
  );
}
