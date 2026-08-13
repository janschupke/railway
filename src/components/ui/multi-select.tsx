"use client";

import { useState } from "react";
import { Popover as Primitive } from "radix-ui";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { Checkbox } from "./checkbox";

export type MultiSelectOption<T extends string> = { value: T; label: string };

/**
 * A dropdown that selects several options at once.
 *
 * Built on Popover rather than a Radix DropdownMenu, and the checkboxes inside are the
 * same native `Checkbox` the rest of the app uses. A menu is a list of *commands* — its
 * `menuitemcheckbox` children are announced as menu items and its arrow-key model exists
 * because a menu closes when you pick something. This closes on nothing: the point is to
 * tick several boxes and see the list narrow behind the popup as you go. A group of
 * checkboxes says exactly that, and costs no new dependency — Popover is already in the
 * dashboard's graph for the image combobox, so this adds no first-load bytes to the
 * route with the least headroom.
 *
 * Selection order is `options` order, not click order, so one selection has one
 * serialisation. Callers that put this in the URL depend on that.
 */
export function MultiSelect<T extends string>({
  label,
  countLabel,
  listLabel,
  options,
  value,
  onValueChange,
  className,
}: {
  /** The trigger's visible text. */
  label: string;
  /**
   * The trigger's whole accessible name while something is selected, e.g.
   * "Status, 2 selected".
   *
   * One catalog string rather than the label with a count appended to it. The count is
   * drawn as a badge and hidden from the name — a bare numeral announced after the label
   * is a riddle — and the sentence that replaces it has to be written per language, since
   * the order of a noun and its count is not English's to decide. It must open with
   * `label`, which is what Label in Name (WCAG 2.5.3) requires of a control whose visible
   * text a speech user will say out loud.
   */
  countLabel: string;
  /** Names the group of checkboxes, which is portalled away from the trigger. */
  listLabel: string;
  options: readonly MultiSelectOption<T>[];
  value: readonly T[];
  onValueChange: (next: T[]) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const chosen = new Set(value);

  const toggle = (option: T, checked: boolean) =>
    onValueChange(
      options
        .filter((o) => (o.value === option ? checked : chosen.has(o.value)))
        .map((o) => o.value),
    );

  return (
    <Primitive.Root open={open} onOpenChange={setOpen}>
      <Primitive.Trigger asChild>
        {/*
          A real bordered control, because this is now the only way to reach nine
          options — `ghost` would leave the one thing that opens the status filter
          looking like a caption.
        */}
        {/*
          No `size`, which means `md` — the same `--control-h-md` the Input beside it
          takes. A trigger that sits on a row with a text field is the case the control
          tokens exist for, and picking a step here rather than inheriting the row's is
          how that row ends up with three heights on it.
        */}
        <Button
          variant="secondary"
          {...(value.length > 0 ? { "aria-label": countLabel } : {})}
          className={cn("shrink-0", className)}
        >
          {label}
          {value.length > 0 && (
            <span
              aria-hidden
              className="bg-accent-bg text-accent text-caption rounded-full px-1.5 py-px"
            >
              {value.length}
            </span>
          )}
          {/*
            Rotates with the popup rather than swapping to a second icon: one element
            that moves reads as the same affordance in both states.
          */}
          <ChevronDown
            aria-hidden
            className="text-text-subtle transition-transform data-[state=open]:rotate-180"
            data-state={open ? "open" : "closed"}
          />
        </Button>
      </Primitive.Trigger>

      <Primitive.Portal>
        <Primitive.Content
          align="start"
          sideOffset={4}
          className={cn(
            "border-border bg-raised animate-content z-overlay",
            "max-h-64 min-w-48 overflow-y-auto rounded-md border p-1 shadow-lg",
          )}
        >
          {/*
            The popup stays open on every tick. Narrowing a list is iterative — the
            answer to "is this enough" is the list itself — and a popup that closed per
            box would make the second choice cost a second trip.
          */}
          <div role="group" aria-label={listLabel} className="flex flex-col">
            {options.map((option) => (
              <Checkbox
                key={option.value}
                label={option.label}
                checked={chosen.has(option.value)}
                onChange={(event) => toggle(option.value, event.target.checked)}
                className="hover:bg-subtle rounded px-2 py-1.5"
              />
            ))}
          </div>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
