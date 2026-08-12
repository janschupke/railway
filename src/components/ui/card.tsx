import { cn } from "@/lib/utils";

export function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("border-border bg-surface rounded-lg border shadow-sm", className)}
      {...props}
    />
  );
}
