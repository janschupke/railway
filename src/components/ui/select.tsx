"use client";

import { Select as Primitive } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { Field } from "./field";
import { byGroup, type GroupedOption } from "./group-options";

type SelectOption = GroupedOption;

/**
 * Styled single-select on Radix.
 *
 * A native <select> is the more accessible default and was what this replaced; Radix
 * earns the swap by being stylable from the design tokens while keeping typeahead,
 * arrow-key navigation, Home/End and Escape. Those are covered by e2e/keyboard.spec.ts —
 * an axe pass alone would not prove any of it.
 */
export function Select({
  label,
  value,
  options,
  onValueChange,
  disabled,
  disabledReason,
  placeholder,
}: {
  /** Rendered as a visible <label>, associated with the trigger. */
  label: string;
  value: string | undefined;
  options: SelectOption[];
  onValueChange: (value: string) => void;
  disabled?: boolean;
  /**
   * Why this control cannot be used, shown under it.
   *
   * A dimmed trigger states that something is unavailable and nothing about why, and an
   * enabled one that opens an empty list is worse — it reads as a broken control rather
   * than an empty one. Required whenever a caller can produce either state.
   */
  disabledReason?: string;
  placeholder?: string;
}) {
  const t = useTranslations("common");

  // Nothing to choose is a disabled control by definition, whatever the caller passed:
  // an open popup with no items in it is not a choice, it is a dead end.
  const empty = options.length === 0;
  const inert = Boolean(disabled) || empty;
  const reason = inert ? disabledReason : undefined;

  return (
    <Field label={label} {...(reason ? { hint: reason } : {})}>
      {({ id, "aria-describedby": describedBy }) => (
        <Primitive.Root value={value} onValueChange={onValueChange} disabled={inert}>
          <Primitive.Trigger
            id={id}
            aria-describedby={describedBy}
            /*
             * `w-full`, not `inline-flex`. A content-sized trigger resizes as the
             * selection changes, so the row shuffled under the cursor every time someone
             * picked a project with a longer name. Filling the slot is this component's
             * business; how wide the slot is belongs to the caller, which is why there is
             * still no className prop here.
             */
            className={cn(
              "focus-ring border-border bg-surface text-text flex w-full items-center justify-between gap-2",
              "text-body h-control-md px-control-md rounded-md border",
              "hover:bg-subtle data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
            )}
          >
            {/* truncate + shrink-0, so a long project name cannot squeeze out the
                affordance that says this is a menu. */}
            <Primitive.Value
              className="truncate"
              placeholder={placeholder ?? t("selectPlaceholder")}
            />
            <Primitive.Icon>
              <ChevronDown aria-hidden className="text-text-subtle size-4 shrink-0" />
            </Primitive.Icon>
          </Primitive.Trigger>

          <Primitive.Portal>
            <Primitive.Content
              position="popper"
              sideOffset={4}
              className={cn(
                "border-border bg-raised z-overlay max-h-64 min-w-[var(--radix-select-trigger-width)]",
                "overflow-hidden rounded-md border shadow-lg",
                /*
                 * Enter only, for the reason tooltip.tsx gives: Presence keeps a closing
                 * node mounted for as long as an animation runs on it, and this one is a
                 * modal layer — it holds a scroll lock and `aria-hidden` on the rest of
                 * the document while it lives. A dismissed dropdown is a user getting
                 * back to work, so it goes at once; the dialog and the toast, which
                 * announce and confirm, animate both ways.
                 */
                "animate-content-enter",
              )}
            >
              <Primitive.Viewport className="p-1">
                {byGroup(options).map(([group, groupOptions]) => {
                  const items = groupOptions.map((option) => (
                    <Primitive.Item
                      key={option.value}
                      value={option.value}
                      className={cn(
                        "text-text flex cursor-pointer items-center justify-between gap-2 rounded px-2 py-1.5",
                        "text-body outline-none select-none",
                        "data-[highlighted]:bg-subtle data-[state=checked]:text-accent",
                      )}
                    >
                      <Primitive.ItemText>{option.label}</Primitive.ItemText>
                      <Primitive.ItemIndicator>
                        <Check aria-hidden className="size-3.5" />
                      </Primitive.ItemIndicator>
                    </Primitive.Item>
                  ));

                  // Ungrouped options are not wrapped: an unlabelled Group would still
                  // announce itself to a screen reader as a group with no name.
                  if (group === null) return items;

                  return (
                    <Primitive.Group key={group}>
                      <Primitive.Label className="text-text-subtle text-caption px-2 py-1">
                        {group}
                      </Primitive.Label>
                      {items}
                    </Primitive.Group>
                  );
                })}
              </Primitive.Viewport>
            </Primitive.Content>
          </Primitive.Portal>
        </Primitive.Root>
      )}
    </Field>
  );
}
