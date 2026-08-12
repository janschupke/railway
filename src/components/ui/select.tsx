"use client";

import { Select as Primitive } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type SelectOption = { value: string; label: string };

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
  placeholder = "Select…",
}: {
  /** Accessible name; this control has no visible <label> of its own. */
  label: string;
  value: string | undefined;
  options: SelectOption[];
  onValueChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <Primitive.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <Primitive.Trigger
        aria-label={label}
        className={cn(
          "focus-ring border-border bg-surface text-text inline-flex h-9 items-center gap-2",
          "rounded-md border px-2.5 text-sm",
          "hover:bg-subtle data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
        )}
      >
        <Primitive.Value placeholder={placeholder} />
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
            {options.map((option) => (
              <Primitive.Item
                key={option.value}
                value={option.value}
                className={cn(
                  "text-text flex cursor-pointer items-center justify-between gap-2 rounded px-2 py-1.5",
                  "text-sm outline-none select-none",
                  "data-[highlighted]:bg-subtle data-[state=checked]:text-accent",
                )}
              >
                <Primitive.ItemText>{option.label}</Primitive.ItemText>
                <Primitive.ItemIndicator>
                  <Check aria-hidden className="size-3.5" />
                </Primitive.ItemIndicator>
              </Primitive.Item>
            ))}
          </Primitive.Viewport>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
