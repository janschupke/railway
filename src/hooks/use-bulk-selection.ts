"use client";

import { useMemo, useState } from "react";
import { LIMITS } from "@/lib/constants";

/** A stable empty set, so the derived selection is not a new identity every render. */
const EMPTY_SELECTION: ReadonlySet<string> = new Set();

/**
 * Which rows are ticked, for a batch the user is about to act on.
 *
 * Sits beside `use-container-filters` and `use-incremental-list`, which are exactly this
 * shape and were extracted already; this is the one that was left behind in
 * `container-list.tsx`.
 *
 * **Deliberately not in the URL.** ADR-7 puts the list's filters there because a filtered
 * list is worth sharing; a set of containers somebody is about to destroy is the opposite
 * of that. It is also the one piece of state here that must not survive a reload — a link
 * that arrives with six services pre-selected for deletion is a link worth being suspicious
 * of.
 *
 * Reset on `listKey` by deriving during render, the pattern `useIncrementalList` uses for
 * its page count and for the same reason: an effect would commit one render against the old
 * selection first. Changing what you are looking at clears what you had picked, which is
 * both predictable and what keeps a row hidden by a filter out of the batch.
 */
export function useBulkSelection<Item extends { readonly serviceId: string }>(
  selectable: readonly Item[],
  listKey: string,
) {
  const [selection, setSelection] = useState({ key: listKey, ids: new Set<string>() });
  if (selection.key !== listKey) setSelection({ key: listKey, ids: new Set() });
  /*
   * The stale set, for the one render between the key changing and the update above
   * landing. A shared constant rather than a fresh `new Set()` per render, because it feeds
   * the `selected` memo below — an inline literal would give that memo a new dependency
   * identity every time and turn it into a no-op.
   */
  const selectedIds = selection.key === listKey ? selection.ids : EMPTY_SELECTION;

  /*
   * The selection as items, derived rather than stored.
   *
   * Intersected with `selectable` on every render, so a row that has been destroyed,
   * filtered away or turned out not to be ours cannot reach the confirmation — the set of
   * ids is a record of what was ticked, and this is the answer to what that currently
   * means. Ordered by the list rather than by click order, so a dialog reads in the order
   * on screen.
   */
  const selected = useMemo(
    () => selectable.filter((item) => selectedIds.has(item.serviceId)),
    [selectable, selectedIds],
  );

  const setSelected = (serviceId: string, checked: boolean) => {
    setSelection((current) => {
      const ids = new Set(current.ids);
      if (checked) ids.add(serviceId);
      else ids.delete(serviceId);
      return { key: listKey, ids };
    });
  };

  /*
   * Select-all reaches the whole selectable set, not the page on screen.
   *
   * That is the set the summary sentence counts and the set the filters describe, so it is
   * the set "all" means here — a checkbox that silently meant "the twenty rows rendered so
   * far" would depend on how far the reader had scrolled.
   *
   * Capped at what one request may carry. The caller says so when it bites, because a tick
   * that quietly selected fifty of eighty is the list telling the user something untrue
   * about their own selection.
   */
  const capped = selectable.slice(0, LIMITS.BULK_DESTROY_MAX);
  const allSelected = capped.length > 0 && selected.length === capped.length;
  const selectAll = (checked: boolean) =>
    setSelection({
      key: listKey,
      ids: new Set(checked ? capped.map((item) => item.serviceId) : []),
    });

  return {
    selected,
    setSelected,
    selectAll,
    allSelected,
    capped,
    /** Empties the selection — what a batch action calls once it has been carried out. */
    clear: () => setSelection({ key: listKey, ids: new Set() }),
    /*
     * A predicate rather than the set itself, so a row asks a question instead of being
     * handed the state. It reads `selectedIds` and not `selected`, because a row is ticked
     * the moment it is ticked — intersecting with `selectable` is what `selected` is for,
     * and doing it per row would be quadratic besides.
     */
    isSelected: (serviceId: string) => selectedIds.has(serviceId),
  };
}
