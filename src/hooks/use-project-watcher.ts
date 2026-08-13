"use client";

import { useEffect } from "react";
import { useThrottledRefresh } from "./use-throttled-refresh";

/** Backoff after a fatal connection failure. Nothing here is urgent. */
const RETRY_BASE_MS = 5_000;
const RETRY_CEILING_MS = 60_000;

/**
 * Keeps the container list in step with Railway without polling from the browser.
 *
 * Holds one EventSource to /api/watch, which says only "something changed" — the server
 * does the polling and the diffing, and this answers by calling router.refresh() so the
 * page re-renders through the normal RSC path. No application state crosses this wire.
 *
 * Nothing is held while the tab is hidden. That is the whole reason this is cheap: a
 * dashboard left open in a background tab costs no connection and no Railway requests,
 * and catches up with a single refresh when it comes back.
 */
export function useProjectWatcher(
  projectId: string | null,
  environmentId: string | null,
) {
  /*
   * The throttle is shared across the tab, not held here. It used to live in this
   * effect's closure, which meant it only ever coalesced this watcher's own refreshes —
   * never the per-row ones firing on the same event.
   */
  const refresh = useThrottledRefresh();

  useEffect(() => {
    if (!projectId || !environmentId) return;

    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retry = 0;

    const close = () => {
      source?.close();
      source = null;
      clearTimeout(timer);
    };

    const open = () => {
      if (source || document.visibilityState !== "visible") return;

      source = new EventSource(
        `/api/watch/${encodeURIComponent(projectId)}?environment=${encodeURIComponent(environmentId)}`,
      );

      source.addEventListener("ready", () => {
        retry = 0;
      });
      source.addEventListener("changed", refresh);
      source.addEventListener("error", (event) => {
        const named = (() => {
          try {
            return JSON.parse((event as MessageEvent).data) as { message?: string };
          } catch {
            return null;
          }
        })();

        // A named error is a revoked authorization. Refreshing hands the problem to the
        // proxy, which is the thing that knows how to redirect.
        if (named?.message) {
          close();
          refresh();
          return;
        }

        // CONNECTING means the browser is already redialling; only CLOSED is ours to
        // handle. Same distinction as use-deployment-stream, and for the same reason.
        if (source?.readyState !== EventSource.CLOSED) return;
        close();
        timer = setTimeout(
          open,
          Math.min(RETRY_CEILING_MS, RETRY_BASE_MS * 2 ** retry++),
        );
      });
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        // The tab may have been hidden for an hour; catch up before watching again.
        refresh();
        open();
      } else {
        close();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    open();

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      close();
    };
  }, [projectId, environmentId, refresh]);
}
