"use client";

import { Tooltip as Primitive } from "radix-ui";
import { cn } from "@/lib/utils";

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
    <Primitive.Provider delayDuration={200}>
      <Primitive.Root>
        <Primitive.Trigger asChild>{children}</Primitive.Trigger>
        <Primitive.Portal>
          <Primitive.Content
            side={side}
            sideOffset={6}
            className={cn(
              "border-border bg-raised text-text z-50 rounded-md border px-2 py-1",
              "text-xs shadow-md",
            )}
          >
            {content}
            <Primitive.Arrow className="fill-[var(--rc-raised)]" />
          </Primitive.Content>
        </Primitive.Portal>
      </Primitive.Root>
    </Primitive.Provider>
  );
}
