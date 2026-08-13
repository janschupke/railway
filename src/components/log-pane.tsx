"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { UI } from "@/lib/constants";
import type { StreamStatus } from "@/hooks/use-deployment-stream";
import type { LogLine } from "@/lib/railway/types";
import { ScrollArea } from "./ui/scroll-area";
import { Button } from "./ui/button";
import { Text } from "./ui/text";

/**
 * Log output with autoscroll that yields to the reader.
 *
 * Scrolling up detaches the tail and surfaces a button to reattach. Tailing that fights
 * the user is worse than no tailing — you cannot read a failure while it scrolls away.
 */
export function LogPane({
  lines,
  status,
  emptyLabel,
}: {
  lines: LogLine[];
  status: StreamStatus;
  /** What "connected and quiet" means here; ignored in the other two states. */
  emptyLabel?: string;
}) {
  const t = useTranslations("containers");
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
        className="bg-subtle h-pane-log rounded-md"
        viewportClassName="p-3"
        viewportRef={viewportRef}
        viewportProps={{
          /*
           * `role="log"` carries an implicit aria-live of polite, which is exactly what
           * a build emitting hundreds of lines needs — assertive would be unusable. The
           * explicit attribute was redundant rather than additive, and on a dashboard
           * already holding several regions the cheapest one to remove is the one that
           * says nothing the role does not.
           */
          role: "log",
          "aria-label": t("logsLabel"),
        }}
      >
        {lines.length === 0 ? (
          <Text asChild variant="mono" tone="muted">
            {/*
              Three states, not two. A stream that closed having emitted nothing has
              finished its job — saying "Connecting…" there is a lie that never resolves,
              which is exactly what a successful deployment with no log output produced.
            */}
            <p>
              {status === "connecting"
                ? t("connecting")
                : status === "closed"
                  ? t("noLogOutput")
                  : (emptyLabel ?? t("waitingForOutput"))}
            </p>
          </Text>
        ) : (
          // The mono variant carries its own leading, so these rows, the empty state above
          // and log-pane-skeleton.tsx can no longer disagree about it — which they did,
          // the two placeholders standing in at a tighter line height than the real thing.
          <div className="text-mono font-mono">
            {lines.map((line, index) => (
              <div
                key={`${line.timestamp}-${index}`}
                className="text-text whitespace-pre"
              >
                <span className="text-text-subtle mr-2 select-none">
                  {/* `||`, not `??`: an empty timestamp slices to "" and must
                      still fall back to the placeholder. */}
                  {line.timestamp?.slice(11, 19) || t("noTimestamp")}
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
          {t("jumpToLatest")}
        </Button>
      )}
    </div>
  );
}
