"use client";

import { useCallback, useMemo, useState } from "react";
import { LIST } from "@/lib/constants";

/**
 * Renders a long list a page at a time, growing as the reader reaches the bottom.
 *
 * Paging is presentational — Railway hands over every service in one response — so this
 * bounds what is *mounted*, which is the cost that matters: every visible row is a client
 * component that may hold a log EventSource against a browser connection cap of six.
 *
 * `resetKey` is a signature of the *selection*, not of the data. That distinction is the
 * whole hook. `router.refresh()` fires from the project watcher on every Railway change
 * and from every row whose deployment settles, and each one lands a structurally new
 * `items` array. Resetting on the array would yank a reader at row 80 back to row 20
 * every few seconds, for a reason invisible in the diff — so the reset compares a string
 * the reader controls instead, using the derive-during-render pattern rather than an
 * effect, so the new page count is committed in the same render as the new filters.
 */
export function useIncrementalList<T>(items: T[], resetKey: string) {
  const [state, setState] = useState({ key: resetKey, pages: 1 });
  if (state.key !== resetKey) setState({ key: resetKey, pages: 1 });

  const pages = state.key === resetKey ? state.pages : 1;
  const limit = pages * LIST.PAGE_SIZE;

  const visible = useMemo(() => items.slice(0, limit), [items, limit]);
  const hasMore = items.length > visible.length;
  /** Whether anything was ever held back — a short list gets no footer at all. */
  const paged = items.length > LIST.PAGE_SIZE;

  /**
   * The manual way forward, and the only one that exists without a scroll gesture.
   *
   * The caller renders a control for this whenever `hasMore`, rather than only where the
   * observer is unavailable — an observer-driven list is unreachable by keyboard
   * otherwise. That is also why this hook reports no "did autoload fail" flag: it had
   * one, and with the control rendered unconditionally there was nothing for it to
   * change. A capability read during render is a hydration mismatch besides — the server
   * has no IntersectionObserver and every browser does.
   */
  const loadMore = useCallback(() => {
    setState((current) => ({ ...current, pages: current.pages + 1 }));
  }, []);

  /*
   * A callback ref rather than useEffect + a ref object: the sentinel is only in the DOM
   * while there is more to load, so the element arrives and departs, and the callback
   * form is the one that hears about both.
   *
   * Keyed on `hasMore` rather than reading it through a ref kept fresh during render.
   * React detaches and re-attaches a callback ref when its identity changes, so the
   * observer is simply rebuilt on the one transition that matters — and it stays put
   * across the far commoner page-count change, where a still-visible sentinel firing
   * again is exactly what a fast scroll needs.
   */
  const sentinelRef = useCallback(
    (node: Element | null) => {
      if (!node || typeof IntersectionObserver === "undefined") return;

      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting) && hasMore) loadMore();
        },
        { rootMargin: `${LIST.SENTINEL_ROOT_MARGIN_PX}px`, threshold: 0 },
      );
      observer.observe(node);
      return () => observer.disconnect();
    },
    [hasMore, loadMore],
  );

  return { visible, hasMore, paged, loadMore, sentinelRef };
}
