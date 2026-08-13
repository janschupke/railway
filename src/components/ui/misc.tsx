import { LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Text } from "./text";
import { LiveRegion } from "./live-region";

/**
 * Busy indicator.
 *
 * Deliberately decorative: `prefers-reduced-motion` freezes every animation globally
 * (see globals.css), so a frozen spinner would be the only signal left. The meaning has
 * to live in adjacent text — which is why `Button` pairs this with `pendingLabel`
 * rather than relying on the spin alone.
 */
export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle aria-hidden className={cn("animate-spin", className)} />;
}

/**
 * Polite announcement for work in flight.
 *
 * Swapping a button's label mid-action is not reliably announced — assistive tech does
 * not re-read the accessible name of the element it is already sitting on — so progress
 * gets its own region. The region stays mounted and empty when idle: injecting the
 * element and its text together is the classic way to have an announcement dropped.
 *
 * Pass `className="sr-only"` where the surrounding UI already shows the state visually.
 */
export function PendingStatus({
  label,
  className,
}: {
  /** Rendered and announced only while set. */
  label?: string | undefined;
  className?: string;
}) {
  return (
    <LiveRegion
      // The region itself is LiveRegion's job — see there for why it stays mounted
      // while idle and why it carries no role.
      data-pending-status={label ? "" : undefined}
      className={cn(
        "text-text-subtle text-caption flex items-center gap-1.5",
        className,
      )}
    >
      {label ? (
        <>
          <Spinner className="size-3.5" />
          {label}
        </>
      ) : null}
    </LiveRegion>
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
      <Text asChild variant="label">
        <p>{title}</p>
      </Text>
      <Text asChild variant="body" tone="muted">
        <p className="max-w-sm">{description}</p>
      </Text>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
