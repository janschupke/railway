import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Spinner } from "./misc";

const buttonVariants = cva(
  cn(
    "focus-ring inline-flex items-center justify-center gap-2 font-medium whitespace-nowrap",
    /*
     * `cursor-not-allowed`, not `pointer-events-none`, and the difference was doing real
     * damage. `globals.css` has carried `button:disabled { cursor: not-allowed }` in
     * @layer base since the Tailwind v4 preflight change — but an element with
     * `pointer-events: none` never becomes the hover target, so the cursor stayed an
     * arrow and a disabled control was indistinguishable from a dim one. It also swallows
     * the pointer events a Radix Tooltip trigger listens for, which is why every icon
     * button that is disabled some of the time could not explain itself.
     *
     * Nothing is lost in activation terms: a native disabled <button> dispatches no click.
     * Hover is suppressed per variant below with `not-disabled:` rather than by removing
     * the element from hit-testing.
     */
    "rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ),
  {
    variants: {
      /*
       * Four weights, and the choice is about how much the control should assert itself
       * rather than what it does: `primary` for the one action a screen exists for,
       * `secondary` for a real but ordinary action, `danger` for destructive ones and
       * for anything answering a failure, `ghost` only for tertiary in-place actions
       * (an inline menu trigger, a dialog's Cancel) that sit beside something louder.
       *
       * Chrome is not tertiary: Sign out reads as text when it is `ghost`, especially
       * next to the bordered theme toggle, so it takes `secondary`.
       */
      /*
       * Every hover is `not-disabled:`, which is load-bearing rather than tidy. The base
       * no longer removes a disabled button from hit-testing (see above), so a plain
       * `hover:` would now light up a control that refuses to act — the exact lie the
       * dimming is there to prevent.
       */
      variant: {
        primary: "bg-accent text-accent-fg not-disabled:hover:bg-accent-hover",
        secondary: "border-border bg-surface not-disabled:hover:bg-subtle border",
        // Surface-backed rather than transparent, so it stays a legible control on a
        // tinted danger block as well as on a plain card.
        danger:
          "border-danger-border text-danger bg-surface not-disabled:hover:bg-danger-bg border",
        ghost:
          "text-text-muted not-disabled:hover:bg-subtle not-disabled:hover:text-text",
      },
      /*
       * Height and inset come from the shared control tokens, so a button, an input and
       * a select trigger on the same row cannot disagree — which they did, at three
       * heights and two insets. Type size stays `body` at every step: a control that
       * shrinks its text as it shrinks its box reads as a different kind of control.
       */
      size: {
        sm: "h-control-sm px-control-sm text-body [&_svg]:size-3.5",
        md: "h-control-md px-control-md text-body [&_svg]:size-4",
        lg: "h-control-lg px-control-lg text-body [&_svg]:size-4",
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
   *
   * The handler is attached only when it has work to do. A plain always-enabled link —
   * an external "Open Railway", say — needs no JavaScript at all, and passing a function
   * it would never call makes the whole button unusable from a Server Component, since
   * event handlers cannot cross that boundary. An *inert* slotted link still needs the
   * guard, so one of those does have to be rendered from a Client Component.
   */
  const guarded = inert || Boolean(onClick);
  const activation = asChild
    ? {
        "aria-disabled": inert || undefined,
        ...(guarded
          ? {
              onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
                if (inert) {
                  event.preventDefault();
                  return;
                }
                onClick?.(event);
              },
            }
          : {}),
      }
    : { type, disabled: inert, onClick };

  const shared = {
    "aria-busy": pending || undefined,
    className: cn(
      buttonVariants({ variant, size }),
      /*
       * The cva `disabled:` variants cannot reach an aria-disabled anchor, and this path
       * deliberately keeps `pointer-events-none` where the base rule above dropped it.
       *
       * The asymmetry is a navigation guard rather than an oversight. A slotted <a> is
       * still followed on a middle-click or a ctrl-click, neither of which the onClick
       * preventDefault sees — and the one inert slotted button in the app is
       * sign-in-button.tsx mid-OIDC, where a second click starts a second round trip.
       * A cursor on a control that is already spinning is worth less than that.
       */
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
