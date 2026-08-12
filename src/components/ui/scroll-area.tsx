"use client";

import { ScrollArea as Primitive } from "radix-ui";
import { cn } from "@/lib/utils";

/**
 * Scroll container with a consistent, themeable scrollbar.
 *
 * `viewportRef` is exposed because the log pane needs the scrolling element itself to
 * implement autoscroll — Radix renders it inside, so without this the caller would have
 * to reach into the DOM by selector.
 */
export function ScrollArea({
  className,
  viewportClassName,
  viewportRef,
  viewportProps,
  children,
}: {
  className?: string;
  viewportClassName?: string;
  viewportRef?: React.Ref<HTMLDivElement>;
  viewportProps?: React.ComponentProps<"div">;
  children: React.ReactNode;
}) {
  return (
    <Primitive.Root className={cn("overflow-hidden", className)}>
      <Primitive.Viewport
        ref={viewportRef}
        className={cn("size-full", viewportClassName)}
        {...viewportProps}
      >
        {children}
      </Primitive.Viewport>

      <Primitive.Scrollbar
        orientation="vertical"
        className="flex w-2 touch-none p-0.5 select-none"
      >
        <Primitive.Thumb className="bg-border-strong flex-1 rounded-full" />
      </Primitive.Scrollbar>
      <Primitive.Scrollbar
        orientation="horizontal"
        className="flex h-2 touch-none flex-col p-0.5 select-none"
      >
        <Primitive.Thumb className="bg-border-strong flex-1 rounded-full" />
      </Primitive.Scrollbar>
      <Primitive.Corner />
    </Primitive.Root>
  );
}
