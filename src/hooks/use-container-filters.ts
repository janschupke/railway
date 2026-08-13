"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  filterQueryString,
  parseFilters,
  type ContainerFilters,
} from "@/lib/container-filters";
import { LIST } from "@/lib/constants";
import { useDebouncedValue } from "./use-debounced-value";

/**
 * The container list's filter state, held in the URL and written without a round trip.
 *
 * ## Why the URL, and why not the router
 *
 * ADR-7: the URL is the state. Filters belong there — a filtered list is linkable,
 * survives a reload, and needs no store. But /dashboard is `force-dynamic` and Railway's
 * project query accepts no filter arguments, so a `router.replace` per keystroke would
 * re-run two Railway requests to hand back a list this app then filters in memory anyway.
 *
 * So the write goes through `window.history.replaceState`, which Next patches
 * (app-router.js) to dispatch a restore the router understands: `usePathname` and
 * `useSearchParams` see the new URL, the restore reducer seeds from the tree's own
 * `renderedSearch` so every segment key still hits the cache, and no request is made.
 * Search params are also excluded from the React state key by design
 * (`createRouterCacheKey(segment, withoutSearchParameters)`), which is what lets the
 * watcher's `router.refresh()` land without remounting the list and losing its page count.
 *
 * ## The trap
 *
 * Next's patched `replaceState` early-returns *before* updating the router when handed a
 * state object carrying its own markers — and `window.history.state` on any App Router
 * page has `__NA: true`. The idiomatic-looking `replaceState(window.history.state, …)`
 * therefore updates the address bar and leaves `useSearchParams` stale, which looks
 * correct in the browser and in review. Pass `null`; Next re-attaches its internals.
 *
 * ## The refresh loop this is shaped to avoid
 *
 * See README ADR-7: a fresh `t` identity in a dependency array once turned a refresh into
 * a loop. Nothing here depends on a non-primitive that changes when we write — the commit
 * effect watches the debounced string, and the commit itself is guarded to a no-op when
 * the URL it would write is the URL already showing.
 */
export function useContainerFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const search = params.toString();
  const filters = useMemo(() => parseFilters(new URLSearchParams(search)), [search]);

  /** The input's unconfirmed buffer. */
  const [draftState, setDraft] = useState(filters.query);
  /** The URL query this hook last reconciled the buffer against. */
  const [seen, setSeen] = useState(filters.query);

  const debouncedDraft = useDebouncedValue(draftState, LIST.SEARCH_DEBOUNCE_MS);

  /*
   * Re-seed the buffer only when the URL's query moved for a reason that is not this
   * hook — a Back, a Clear, a link opened in place.
   *
   * The second condition is what makes that distinction, and it is load-bearing. The
   * settled draft is exactly what gets committed, so a URL query equal to it is our own
   * write coming back. Re-seeding on that would discard whatever was typed during the
   * round trip: settle on "r" while the reader reaches "red", and the box snaps to "r".
   *
   * A render-phase update rather than an effect, so the corrected value is committed in
   * the same render and the box never paints a stale character.
   */
  let draft = draftState;
  if (filters.query !== seen) {
    setSeen(filters.query);
    if (filters.query !== debouncedDraft.trim()) {
      draft = filters.query;
      setDraft(draft);
    }
  }

  const commit = useCallback(
    (next: ContainerFilters) => {
      const query = filterQueryString(new URLSearchParams(search), next);
      // The loop breaker. Also what makes a flushed debounce free after Enter.
      if (query === search.replace(/%2C/g, ",")) return;

      const url = query ? `${pathname}?${query}` : pathname;

      if (typeof window !== "undefined" && window.history?.replaceState) {
        window.history.replaceState(null, "", url);
      } else {
        // No history API — a non-browser test environment, or a browser old enough that
        // a server round trip is the least of its problems. `scroll: false` because a
        // filter change must not jump the page to the top.
        router.replace(url, { scroll: false });
      }
    },
    [pathname, router, search],
  );

  useEffect(() => {
    commit({
      ...parseFilters(new URLSearchParams(search)),
      query: debouncedDraft.trim(),
    });
    // Primitives and a stable callback only. Never `filters`, whose identity is fresh
    // per parse, and never the ReadonlyURLSearchParams instance, whose identity changes
    // precisely when this effect writes — the shape of the loop.
  }, [debouncedDraft, commit, search]);

  return {
    /** Parsed from the URL. What the list actually filters by. */
    filters,
    /** The search box's current text, which may not have settled yet. */
    draft,
    setDraft,
    /** Enter: skip the remaining debounce. */
    flushDraft: useCallback(
      () => commit({ ...filters, query: draft.trim() }),
      [commit, filters, draft],
    ),
    /** Chips and checkboxes commit on click, with no effect and no debounce. */
    setStatuses: useCallback(
      (statuses: ContainerFilters["statuses"]) => commit({ ...filters, statuses }),
      [commit, filters],
    ),
    setOwners: useCallback(
      (owners: ContainerFilters["owners"]) => commit({ ...filters, owners }),
      [commit, filters],
    ),
    clear: useCallback(() => {
      setDraft("");
      commit({ query: "", statuses: [], owners: [] });
    }, [commit]),
  };
}
