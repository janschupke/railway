"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { WATCH } from "@/lib/constants";

/**
 * When the last refresh actually went out, shared by every caller in the tab.
 *
 * Module scope is the entire point. Both refresh sources already carried a guard, but
 * each held it in its own closure — the project watcher's inside a `useEffect`, and the
 * rows had none at all — so N rows settling in the same second cost N refreshes of a
 * `force-dynamic` route, which is 2N Railway round trips against a rate limit the rest
 * of this codebase treats as the binding constraint. A per-instance guard cannot
 * coalesce across instances by construction, however small the interval.
 *
 * A module variable rather than a ref or a context: a ref is per-component, and a
 * context provider on the dashboard's critical path is a lot of machinery for one
 * number that no component needs to read.
 */
let lastRefresh = 0;

/** Test seam. The counter outlives a render, so it has to outlive a test too. */
export function __resetRefreshThrottle(): void {
  lastRefresh = 0;
}

/**
 * `router.refresh()`, at most once per WATCH.MIN_REFRESH_GAP_MS across the whole tab.
 *
 * Dropping rather than trailing-edge queueing is deliberate. The caller's own state is
 * already correct — a row's badge has flipped from its stream before this runs, and the
 * watcher only fires on a change it has already been told about — so a refresh that is
 * skipped costs at most `MIN_REFRESH_GAP_MS` of staleness in the *server's* copy of a
 * list the user is not currently reading. A queued trailing refresh would pay the two
 * round trips anyway and arrive after the moment it mattered.
 */
export function useThrottledRefresh(): () => void {
  const router = useRouter();

  return useCallback(() => {
    const now = Date.now();
    if (now - lastRefresh < WATCH.MIN_REFRESH_GAP_MS) return;
    lastRefresh = now;
    router.refresh();
  }, [router]);
}
