"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { UI } from "@/lib/constants";
import type { LogLine } from "@/lib/railway/types";
import { ScrollArea } from "./ui/scroll-area";
import { Button } from "./ui/button";

/**
 * Log output with autoscroll that yields to the reader.
 *
 * Scrolling up detaches the tail and surfaces a button to reattach. Tailing that fights
 * the user is worse than no tailing — you cannot read a failure while it scrolls away.
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
  const viewportRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el || !pinned) return;
    el.scrollTop = el.scrollHeight;
  }, [lines, pinned]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      setPinned(distance <= UI.AUTOSCROLL_THRESHOLD_PX);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="relative">
      <ScrollArea
        className="bg-subtle h-64 rounded-md"
        viewportClassName="p-3"
        viewportRef={viewportRef}
        viewportProps={{
          role: "log",
          // Polite: a build emits hundreds of lines and assertive would be unusable.
          "aria-live": "polite",
          "aria-label": "Container logs",
        }}
      >
        {lines.length === 0 ? (
          <p className="text-text-muted font-mono text-xs">
            {connected ? emptyLabel : "Connecting…"}
          </p>
        ) : (
          <div className="font-mono text-xs leading-relaxed">
            {lines.map((line, index) => (
              <div
                key={`${line.timestamp}-${index}`}
                className="text-text whitespace-pre"
              >
                <span className="text-text-subtle mr-2 select-none">
                  {/* `||`, not `??`: an empty timestamp slices to "" and must
                      still fall back to the placeholder. */}
                  {line.timestamp?.slice(11, 19) || "--:--:--"}
                </span>
                {line.message}
              </div>
            ))}
          </div>
        )}
      </ScrollArea>

      {!pinned && (
        <Button
          size="sm"
          onClick={() => setPinned(true)}
          className="absolute right-3 bottom-3 rounded-full shadow-sm"
        >
          Jump to latest
        </Button>
      )}
    </div>
  );
}
