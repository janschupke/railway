import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  cn(
    "focus-ring inline-flex items-center justify-center gap-2 font-medium whitespace-nowrap",
    "rounded-md transition-colors disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ),
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-fg hover:bg-accent-hover",
        secondary: "border-border bg-surface hover:bg-subtle border",
        danger:
          "border-danger-border text-danger hover:bg-danger-bg border bg-transparent",
        ghost: "text-text-muted hover:bg-subtle hover:text-text",
      },
      size: {
        sm: "h-8 px-2.5 text-xs [&_svg]:size-3.5",
        md: "h-9 px-3 text-sm [&_svg]:size-4",
        lg: "h-10 px-4 text-sm [&_svg]:size-4",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    /** Render the child element instead of a <button>, keeping the styling. */
    asChild?: boolean;
  };

export function Button({
  className,
  variant,
  size,
  asChild = false,
  type = "button",
  ...props
}: ButtonProps) {
  const Component = asChild ? Slot.Root : "button";
  return (
    <Component
      // Buttons inside forms default to submit; an explicit default avoids
      // accidental submissions from decorative buttons.
      {...(asChild ? {} : { type })}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
