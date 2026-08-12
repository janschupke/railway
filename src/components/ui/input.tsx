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
        "focus-ring border-border bg-surface text-text text-body h-control-md px-control-md w-full rounded-md border",
        "placeholder:text-text-subtle disabled:cursor-not-allowed disabled:opacity-50",
        invalid && "border-danger-border",
        className,
      )}
      {...props}
    />
  );
}
