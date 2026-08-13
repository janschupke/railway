"use client";

import { AlertDialog as Primitive } from "radix-ui";
import { cn } from "@/lib/utils";

/**
 * Confirmation dialog for destructive actions.
 *
 * AlertDialog rather than Dialog: it takes focus on open, traps it, restores it to the
 * trigger on close, and is announced as `alertdialog` so the consequence is read before
 * the buttons. The previous inline-form confirmation did none of that.
 */
export const AlertDialogRoot = Primitive.Root;
export const AlertDialogTrigger = Primitive.Trigger;
export const AlertDialogCancel = Primitive.Cancel;

export function AlertDialogContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Overlay className="animate-overlay bg-overlay z-overlay fixed inset-0" />
      <Primitive.Content
        className={cn(
          "border-border bg-raised animate-content z-overlay fixed top-1/2 left-1/2 w-[min(28rem,calc(100vw-2rem))]",
          "-translate-x-1/2 -translate-y-1/2 rounded-xl border p-5 shadow-lg",
          className,
        )}
        {...props}
      >
        {children}
      </Primitive.Content>
    </Primitive.Portal>
  );
}

export function AlertDialogTitle({
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

export function AlertDialogDescription({
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

export function AlertDialogFooter({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("mt-5 flex flex-wrap justify-end gap-2", className)}
      {...props}
    />
  );
}
