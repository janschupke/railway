"use client";

import { X } from "lucide-react";
import { Dialog as Primitive } from "radix-ui";
import { cn } from "@/lib/utils";

/**
 * Modal dialog for a form the user opened on purpose.
 *
 * The non-destructive counterpart to ./alert-dialog. The two are not interchangeable:
 * `alertdialog` interrupts, is announced with its description before anything else, and
 * has no dismiss affordance because the answer is meant to be deliberate. A create form
 * is none of those things — Escape and a close button are the expected exits, and
 * announcing it as an alert would tell a screen-reader user something urgent had happened
 * when they had merely pressed "New project".
 *
 * Shares AlertDialog's geometry and animation classes verbatim, because the two are the
 * same object at different urgencies and a create dialog that opened at a different size
 * would read as a different app. Radix builds AlertDialog on Dialog, so this costs little
 * beyond what the destroy path already loads.
 */
export const DialogRoot = Primitive.Root;
export const DialogTrigger = Primitive.Trigger;
export const DialogClose = Primitive.Close;

export function DialogContent({
  className,
  children,
  closeLabel,
  size = "default",
  ...props
}: React.ComponentProps<typeof Primitive.Content> & {
  closeLabel: string;
  /**
   * `full` is a near-viewport panel for content that is read rather than answered — the
   * maximised log pane. Its height is fixed rather than a maximum because a log viewport
   * has no natural height to hug: the pane should be as tall as the screen allows
   * whether four lines have arrived or four thousand.
   *
   * `panel` is the middle size, for a reading view that has an end — the container
   * detail dialog. `max-h` rather than `h` is the whole difference: the panel hugs its
   * content and stops growing at the viewport, so a dialog holding eight short facts is
   * eight short facts tall. It shares `full`'s column so a long body still scrolls
   * rather than pushing the footer off-screen.
   *
   * A variant rather than a `className` at the call site, and that is the point: no
   * dialog in this app overrides its own geometry, and the moment one does by hand the
   * "same object at different urgencies" property this file shares with ./alert-dialog
   * stops holding. Three sizes are a decision; five spellings are a drift.
   *
   * The two columns exist because their callers have a header and a scrolling body, and
   * the body is what should take the leftover height.
   */
  size?: "default" | "panel" | "full";
}) {
  return (
    <Primitive.Portal>
      <Primitive.Overlay className="animate-overlay bg-overlay z-overlay fixed inset-0" />
      <Primitive.Content
        className={cn(
          "border-border bg-raised animate-content z-overlay fixed top-1/2 left-1/2",
          "-translate-x-1/2 -translate-y-1/2 rounded-xl border p-5 shadow-lg",
          size === "full" &&
            "flex h-[calc(100vh-2rem)] w-[min(80rem,calc(100vw-2rem))] flex-col",
          size === "panel" &&
            "flex max-h-[calc(100vh-2rem)] w-[min(52rem,calc(100vw-2rem))] flex-col",
          size === "default" && "w-[min(28rem,calc(100vw-2rem))]",
          className,
        )}
        {...props}
      >
        {children}
        {/*
          A real control rather than decoration: `closeLabel` is required rather than
          optional so the accessible name cannot be forgotten at a call site, and the icon
          is hidden because the label is the name.
        */}
        <Primitive.Close
          className="focus-ring text-text-muted hover:text-text absolute top-4 right-4 rounded-md p-1 transition-colors"
          aria-label={closeLabel}
        >
          <X aria-hidden />
        </Primitive.Close>
      </Primitive.Content>
    </Primitive.Portal>
  );
}

export function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof Primitive.Title>) {
  return (
    <Primitive.Title
      className={cn(
        "font-display text-text text-title font-semibold tracking-tight",
        className,
      )}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof Primitive.Description>) {
  return (
    <Primitive.Description
      className={cn("text-text-muted text-body mt-1.5", className)}
      {...props}
    />
  );
}

export function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("mt-5 flex flex-wrap justify-end gap-2", className)}
      {...props}
    />
  );
}
