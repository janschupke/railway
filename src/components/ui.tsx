import { cn } from "@/lib/utils";

type ButtonProps = React.ComponentProps<"button"> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
};

export function Button({
  variant = "secondary",
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      className={cn(
        "focus-ring inline-flex items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium",
        "transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        variant === "primary" &&
          "bg-accent text-accent-contrast hover:opacity-90",
        variant === "secondary" &&
          "border border-border bg-surface hover:bg-subtle",
        variant === "danger" &&
          "border border-red-500/40 text-red-600 hover:bg-red-500/10 dark:text-red-400",
        variant === "ghost" && "text-muted hover:bg-subtle hover:text-foreground",
        className,
      )}
    />
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {error ? (
        <span className="text-xs text-red-600 dark:text-red-400">{error}</span>
      ) : hint ? (
        <span className="text-xs text-muted">{hint}</span>
      ) : null}
    </label>
  );
}

export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      {...props}
      className={cn(
        "focus-ring rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm",
        "placeholder:text-muted",
        className,
      )}
    />
  );
}

export function Card({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      {...props}
      className={cn(
        "rounded-lg border border-border bg-surface",
        className,
      )}
    />
  );
}

export function Banner({
  tone,
  children,
}: {
  tone: "error" | "success" | "info";
  children: React.ReactNode;
}) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "rounded-md px-3 py-2 text-sm",
        tone === "error" &&
          "bg-red-500/10 text-red-700 dark:text-red-300",
        tone === "success" &&
          "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        tone === "info" && "bg-subtle text-muted",
      )}
    >
      {children}
    </p>
  );
}
