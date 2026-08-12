import { Separator as SeparatorPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

export function Separator({
  className,
  orientation = "horizontal",
}: {
  className?: string;
  orientation?: "horizontal" | "vertical";
}) {
  return (
    <SeparatorPrimitive.Root
      orientation={orientation}
      className={cn(
        "bg-border",
        orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
        className,
      )}
    />
  );
}

export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("bg-subtle animate-pulse rounded", className)}
      // Decorative: the surrounding region already carries aria-busy.
      aria-hidden
      {...props}
    />
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <p className="text-text text-sm font-medium">{title}</p>
      <p className="text-text-muted max-w-sm text-sm">{description}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
