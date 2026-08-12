"use client";

import { Tooltip as Primitive } from "radix-ui";
import { cn } from "@/lib/utils";

/**
 * Wraps a subtree that contains tooltips.
 *
 * Radix's provider is what makes `delayDuration` grouped rather than per-tooltip: once
 * one tooltip has opened, the next opens immediately. A provider around each individual
 * tooltip — which is what this file used to render — puts every trigger in a group of
 * one, so moving along a list of rows re-pays the delay at every stop.
 */
export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return <Primitive.Provider delayDuration={200}>{children}</Primitive.Provider>;
}

/**
 * Radix Tooltip shows on focus as well as hover, which a `title` attribute does not —
 * that is the whole reason this exists rather than the native tooltip it replaced.
 *
 * Tooltips carry supplementary detail only. Anything a user must read to act belongs in
 * visible text.
 */
export function Tooltip({
  content,
  children,
  side = "top",
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
}) {
  return (
    <Primitive.Root>
      <Primitive.Trigger asChild>{children}</Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content
          side={side}
          sideOffset={6}
          className={cn(
            "border-border bg-raised text-text z-50 rounded-md border px-2 py-1",
            "text-caption shadow-md",
            /*
             * Explicit, because tooltips used to animate only by accident: the old rule
             * targeted the popper wrapper, which every Radix popper shares. Note that
             * Radix Tooltip's content is never data-state="open" — it is delayed-open or
             * instant-open, which globals.css covers.
             *
             * Enter only: a tooltip dismisses nothing, so an exit animation would buy a
             * fade at the cost of a node that outlives its own close.
             */
            "animate-content-enter",
          )}
        >
          {content}
          <Primitive.Arrow className="fill-raised" />
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
