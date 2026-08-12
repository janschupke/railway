import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Spinner } from "./misc";

const buttonVariants = cva(
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

type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    /** Render the child element instead of a <button>, keeping the styling. */
    asChild?: boolean;
    /** Blocks activation, shows a spinner, and marks the control busy. */
    pending?: boolean;
    /**
     * Replaces the label while pending. Pass this whenever the button has a leading
     * icon, since the spinner is added rather than swapped in — without it the icon
     * and the spinner would both render.
     *
     * Ignored under `asChild`: the label lives inside the caller's own element there,
     * so the caller swaps it. `Slot` can only merge onto a single element.
     */
    pendingLabel?: React.ReactNode;
  };

export function Button({
  className,
  variant,
  size,
  asChild = false,
  type = "button",
  pending = false,
  pendingLabel,
  disabled,
  onClick,
  children,
  ...props
}: ButtonProps) {
  const inert = pending || Boolean(disabled);

  /*
   * A Slot-rendered <a> silently ignores `disabled`: :disabled never matches, so it
   * neither dims nor stops responding, and it stays keyboard-activatable. aria-disabled
   * plus a suppressed click is the only shape that holds for both element types, so
   * `disabled` is destructured away above and never reaches the Slot.
   *
   * The element stays focusable on purpose — moving focus to <body> mid-action is worse
   * than a focused control that declines to act.
   */
  const activation = asChild
    ? {
        "aria-disabled": inert || undefined,
        onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
          if (inert) {
            event.preventDefault();
            return;
          }
          onClick?.(event);
        },
      }
    : { type, disabled: inert, onClick };

  const shared = {
    "aria-busy": pending || undefined,
    className: cn(
      buttonVariants({ variant, size }),
      // The cva `disabled:` variants cannot reach an aria-disabled anchor.
      asChild && inert && "pointer-events-none opacity-50",
      className,
    ),
    ...activation,
    ...props,
  };

  if (asChild) {
    return (
      <Slot.Root {...shared}>
        {/*
          Slottable marks which child the props merge onto; its siblings render *inside*
          that element. Without it, passing a spinner alongside the child is two
          children and Slot throws.
        */}
        {pending ? <Spinner /> : null}
        <Slot.Slottable>{children}</Slot.Slottable>
      </Slot.Root>
    );
  }

  return (
    <button {...shared}>
      {pending && <Spinner />}
      {pending ? (pendingLabel ?? children) : children}
    </button>
  );
}
