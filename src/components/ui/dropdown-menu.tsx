"use client";

import { DropdownMenu as Primitive } from "radix-ui";
import { cn } from "@/lib/utils";

/**
 * A list of commands hanging off one trigger.
 *
 * **Why a menu here and not in the filter bar.** `multi-select.tsx` rejected DropdownMenu
 * for the status filter, and its reasoning is the argument for using it here: *"A menu is a
 * list of commands … its arrow-key model exists because a menu closes when you pick
 * something."* A status filter is a set of checkboxes that stay open; a row's actions are
 * exactly a list of commands, each of which ends the menu.
 *
 * The popup recipe — border, raised surface, rounded, `p-1`, `shadow-lg`, `z-overlay` — is
 * the one `select.tsx` and `multi-select.tsx` already share, and `animate-content-enter` is
 * enter-only for the reason both of those give: Presence keeps a closing node mounted for as
 * long as an animation runs on it, and this one is a modal layer holding a scroll lock and
 * `aria-hidden` on the rest of the document. A dismissed menu is somebody getting back to
 * work, so it goes at once.
 */
export const DropdownMenuRoot = Primitive.Root;
export const DropdownMenuTrigger = Primitive.Trigger;

export function DropdownMenuContent({
  className,
  label,
  ...props
}: React.ComponentProps<typeof Primitive.Content> & {
  /**
   * The menu's accessible name, required rather than optional.
   *
   * `DialogContent` makes `closeLabel` required for the same reason and states it: so the
   * accessible name cannot be forgotten at a call site. A menu is worse off than a dialog
   * without one — every row on a list opens a menu whose items all read "Stop", "Restart",
   * "Destroy", and nothing anywhere says which container is about to be destroyed.
   */
  label: string;
}) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        aria-label={label}
        sideOffset={4}
        align="end"
        className={cn(
          "border-border bg-raised animate-content-enter z-overlay min-w-48",
          "rounded-md border p-1 shadow-lg",
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  );
}

export function DropdownMenuItem({
  className,
  ...props
}: React.ComponentProps<typeof Primitive.Item>) {
  return (
    <Primitive.Item
      className={cn(
        "text-text flex cursor-pointer items-center gap-2 rounded px-2 py-1.5",
        "text-body outline-none select-none",
        "data-[highlighted]:bg-highlight",
        // Radix marks a disabled item with `data-disabled` rather than the attribute, so
        // the dimming has to key on that. Kept here even though the row menu renders no
        // disabled lifecycle verb — see the rule in container-actions.tsx — because an
        // item that IS disabled and looks live is worse than one that is never disabled.
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The destructive item, which is the only one that gets a colour.
 *
 * Its own component rather than a `tone` prop, so `container-actions.tsx` writes no
 * appearance at all — the rule that feature components may not. The danger token stays on
 * the text and not the background: a menu of five items with one filled red row reads as an
 * error state rather than as a list with one dangerous entry on it.
 */
export function DropdownMenuDestructiveItem({
  className,
  ...props
}: React.ComponentProps<typeof Primitive.Item>) {
  return (
    <DropdownMenuItem
      className={cn("text-danger data-[highlighted]:bg-danger-bg", className)}
      {...props}
    />
  );
}

/** A rule between groups of items — above the destructive one, and nowhere else so far. */
export function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof Primitive.Separator>) {
  return (
    <Primitive.Separator
      className={cn("bg-border -mx-1 my-1 h-px", className)}
      {...props}
    />
  );
}
