"use client";

import { ToggleGroup as Primitive } from "radix-ui";
import { cn } from "@/lib/utils";

/**
 * Single-choice chip row.
 *
 * Radix gives this roving tabindex — the group is one tab stop and arrow keys move
 * within it — which is the correct pattern for a set of related choices and is what a
 * row of independent `aria-pressed` buttons got wrong.
 */
export function ToggleGroup({
  label,
  value,
  onValueChange,
  options,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <Primitive.Root
      type="single"
      value={value}
      aria-label={label}
      onValueChange={(next) => {
        // Radix emits "" when the active item is re-clicked; this group is not
        // deselectable, so that is ignored rather than blanking the choice.
        if (next) onValueChange(next);
      }}
      className="flex flex-wrap gap-2"
    >
      {options.map((option) => (
        <Primitive.Item
          key={option.value}
          value={option.value}
          className={cn(
            "focus-ring text-caption rounded-full border px-3 py-1 font-medium transition-colors",
            "border-border text-text-muted hover:bg-subtle",
            "data-[state=on]:border-accent data-[state=on]:bg-accent-bg data-[state=on]:text-accent",
          )}
        >
          {option.label}
        </Primitive.Item>
      ))}
    </Primitive.Root>
  );
}
