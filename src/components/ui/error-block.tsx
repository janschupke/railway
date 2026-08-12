import { cn } from "@/lib/utils";

/**
 * A failure and the actions that answer it, in one block.
 *
 * `Banner` is a `<p>`, so a button cannot legally live inside it. That constraint is why
 * the dashboard's Retry ended up stranded on its own line below the tinted message in
 * neutral colours, reading as an unrelated control — the failure said one thing and the
 * only way out of it sat outside the thing that failed. This renders a container, so the
 * actions belong to the message.
 *
 * `Banner` stays the right choice for a message with nothing to do about it.
 */
export function ErrorBlock({
  message,
  actions,
  className,
}: {
  message: React.ReactNode;
  /** Rendered inside the block. Use `variant="danger"` so they read as part of it. */
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "bg-danger-bg border-danger-border space-y-3 rounded-md border px-3 py-3",
        className,
      )}
    >
      <p className="text-danger text-body">{message}</p>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
