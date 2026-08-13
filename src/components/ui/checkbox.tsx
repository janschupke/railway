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
  className,
  ...props
}: Omit<React.ComponentProps<"input">, "type"> & { label: string }) {
  return (
    <label
      className={cn(
        "text-text-muted text-caption flex cursor-pointer items-center gap-2 select-none",
        "has-checked:text-text has-disabled:cursor-not-allowed has-disabled:opacity-50",
        className,
      )}
    >
      <input
        type="checkbox"
        // accent-color rather than a drawn box: it recolours the platform control in both
        // themes and keeps the native focus ring, the indeterminate state and the
        // forced-colors behaviour that a div-with-an-icon quietly drops.
        className="accent-accent focus-ring size-3.5 rounded-sm"
        {...props}
      />
      {label}
    </label>
  );
}
