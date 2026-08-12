"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { LogLine } from "@/lib/railway/types";

const NEAR_BOTTOM_PX = 24;

/**
 * Log output with autoscroll that yields to the reader: scrolling up detaches, and a
 * button reattaches. Tailing that fights the user is worse than no tailing.
 */
export function LogPane({
  lines,
  connected,
  emptyLabel = "Waiting for output…",
}: {
  lines: LogLine[];
  connected: boolean;
  emptyLabel?: string;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el || !pinned) return;
    el.scrollTop = el.scrollHeight;
  }, [lines, pinned]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      setPinned(distance <= NEAR_BOTTOM_PX);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="relative">
      <div
        ref={scrollerRef}
        role="log"
        aria-live="polite"
        aria-label="Container logs"
        className={cn(
          "h-64 overflow-y-auto overflow-x-auto rounded-md bg-subtle p-3",
          "font-mono text-xs leading-relaxed",
        )}
      >
        {lines.length === 0 ? (
          <p className="text-muted">{connected ? emptyLabel : "Connecting…"}</p>
        ) : (
          lines.map((line, index) => (
            <div
              key={`${line.timestamp}-${index}`}
              className="whitespace-pre text-foreground/90"
            >
              <span className="mr-2 select-none text-muted">
                {line.timestamp?.slice(11, 19) ?? "--:--:--"}
              </span>
              {line.message}
            </div>
          ))
        )}
      </div>

      {!pinned && (
        <button
          type="button"
          onClick={() => setPinned(true)}
          className="focus-ring absolute bottom-3 right-3 rounded-full border border-border bg-surface px-3 py-1 text-xs shadow-sm"
        >
          Jump to latest
        </button>
      )}
    </div>
  );
}
