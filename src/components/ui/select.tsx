"use client";

import { Select as Primitive } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

type SelectOption = {
  value: string;
  label: string;
  /**
   * Optional heading to file this option under. Options with no group render loose at
   * the top, so a list where nothing is grouped looks exactly as it did before.
   */
  group?: string;
};

/** Preserves first-seen order, so grouping never reshuffles the caller's list. */
function byGroup(options: SelectOption[]): Array<[string | null, SelectOption[]]> {
  const groups = new Map<string | null, SelectOption[]>();
  for (const option of options) {
    const key = option.group ?? null;
    const existing = groups.get(key);
    if (existing) existing.push(option);
    else groups.set(key, [option]);
  }
  return [...groups.entries()];
}

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
  placeholder,
}: {
  /** Accessible name; this control has no visible <label> of its own. */
  label: string;
  value: string | undefined;
  options: SelectOption[];
  onValueChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const t = useTranslations("common");

  return (
    <Primitive.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <Primitive.Trigger
        aria-label={label}
        className={cn(
          "focus-ring border-border bg-surface text-text inline-flex h-9 items-center gap-2",
          "text-body rounded-md border px-2.5",
          "hover:bg-subtle data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
        )}
      >
        <Primitive.Value placeholder={placeholder ?? t("selectPlaceholder")} />
        <Primitive.Icon>
          <ChevronDown aria-hidden className="text-text-subtle size-4" />
        </Primitive.Icon>
      </Primitive.Trigger>

      <Primitive.Portal>
        <Primitive.Content
          position="popper"
          sideOffset={4}
          className={cn(
            "border-border bg-raised z-50 max-h-64 min-w-[var(--radix-select-trigger-width)]",
            "overflow-hidden rounded-md border shadow-lg",
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
  );
}
