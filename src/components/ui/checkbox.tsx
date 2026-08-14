"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * A labelled checkbox, native.
 *
 * Deliberately not Radix. Radix Checkbox exists to give a styleable box the keyboard and
 * form semantics a native input already has, and this app has no styling requirement that
 * `accent-color` cannot meet — so taking the dependency would spend first-load bytes on
 * every route to reproduce built-in behaviour.
 *
 * The label wraps the input rather than pointing at it by id, so the whole row is the hit
 * target without a useId round trip, and no caller can forget to associate the two.
 */
export function Checkbox({
  label,
  hideLabel,
  indeterminate,
  className,
  ...props
}: Omit<React.ComponentProps<"input">, "type"> & {
  label: string;
  /**
   * Keep the label as the accessible name and take it off the screen.
   *
   * For a box in a grid of them, where the text belongs to the row rather than to the
   * control — a per-row "Select cache" beside a name that already says "cache" is the same
   * word twice. Never an excuse to drop the label: it is still required, still translated,
   * and still what a screen reader reads.
   */
  hideLabel?: boolean;
  /**
   * Neither checked nor unchecked — some of what this box covers is selected.
   *
   * A DOM property with no attribute, so React cannot set it from JSX and it has to be
   * written to the node. This is one of the behaviours the docblock above cites as a reason
   * this is not a div with an icon: the platform draws it, announces it, and gets it right
   * in forced-colors mode without any of it being reimplemented here.
   */
  indeterminate?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = Boolean(indeterminate);
  }, [indeterminate]);

  return (
    <label
      className={cn(
        "text-text-muted text-caption flex cursor-pointer items-center gap-2 select-none",
        "has-checked:text-text has-disabled:cursor-not-allowed has-disabled:opacity-50",
        className,
      )}
    >
      <input
        ref={ref}
        type="checkbox"
        // accent-color rather than a drawn box: it recolours the platform control in both
        // themes and keeps the native focus ring, the indeterminate state and the
        // forced-colors behaviour that a div-with-an-icon quietly drops.
        className="accent-accent focus-ring size-3.5 rounded-sm"
        {...props}
      />
      <span className={cn(hideLabel && "sr-only")}>{label}</span>
    </label>
  );
}
