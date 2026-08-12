import { cn } from "@/lib/utils";

export function Input({
  className,
  invalid,
  ...props
}: React.ComponentProps<"input"> & { invalid?: boolean }) {
  return (
    <input
      // Communicates the error to assistive technology, not just to the eye.
      aria-invalid={invalid || undefined}
      className={cn(
        "focus-ring border-border bg-surface text-text h-9 w-full rounded-md border px-2.5 text-sm",
        "placeholder:text-text-subtle disabled:cursor-not-allowed disabled:opacity-50",
        invalid && "border-danger-border",
        className,
      )}
      {...props}
    />
  );
}
