import { cn } from "@/lib/utils";
import {
  STATE_LABELS,
  isTransitioning,
  type ContainerState,
} from "@/lib/railway/types";

const TONE: Record<ContainerState, string> = {
  pending: "text-amber-700 dark:text-amber-300 bg-amber-500/10",
  building: "text-sky-700 dark:text-sky-300 bg-sky-500/10",
  deploying: "text-sky-700 dark:text-sky-300 bg-sky-500/10",
  running: "text-emerald-700 dark:text-emerald-300 bg-emerald-500/10",
  failed: "text-red-700 dark:text-red-300 bg-red-500/10",
  sleeping: "text-violet-700 dark:text-violet-300 bg-violet-500/10",
  removing: "text-orange-700 dark:text-orange-300 bg-orange-500/10",
  removed: "text-muted bg-subtle",
  unknown: "text-muted bg-subtle",
};

const DOT: Record<ContainerState, string> = {
  pending: "bg-amber-500",
  building: "bg-sky-500",
  deploying: "bg-sky-500",
  running: "bg-emerald-500",
  failed: "bg-red-500",
  sleeping: "bg-violet-500",
  removing: "bg-orange-500",
  removed: "bg-zinc-400",
  unknown: "bg-zinc-400",
};

export function StatusBadge({
  state,
  rawStatus,
}: {
  state: ContainerState;
  rawStatus?: string | null;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        TONE[state],
      )}
      // The raw enum stays available on hover for anyone debugging against Railway.
      title={rawStatus ?? STATE_LABELS[state]}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          DOT[state],
          isTransitioning(state) && "animate-pulse-dot",
        )}
      />
      {STATE_LABELS[state]}
    </span>
  );
}
