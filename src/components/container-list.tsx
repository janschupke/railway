"use client";

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  filterContainers,
  filterKey,
  hasActiveFilters,
  orderContainers,
} from "@/lib/container-filters";
import { sumContainerMetrics } from "@/lib/container-metrics";
import { LIMITS } from "@/lib/constants";
import { formatMemoryGb, formatVcpu } from "@/lib/format";
import type { Container, ContainerMetrics, ContainerVolume } from "@/lib/railway/types";
import { useContainerFilters } from "@/hooks/use-container-filters";
import { useIncrementalList } from "@/hooks/use-incremental-list";
import { BulkDestroyDialog } from "./bulk-destroy-dialog";
import { ContainerFilterBar } from "./container-filter-bar";
import { ContainerRow } from "./container-row";
import { ContainerSectionHeader } from "./container-section-header";
import { ScrollToTop } from "./scroll-to-top";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Checkbox } from "./ui/checkbox";
import { EmptyState } from "./ui/misc";
import { Text } from "./ui/text";
import { LiveRegion } from "./ui/live-region";

/**
 * The filtered, paged container list.
 *
 * A client component holding a server-fetched array, which is the arrangement the data
 * already forced: ContainerRow is a client component, so every Container crossed the
 * boundary before this existed. What moved is the narrowing — Railway's project query
 * takes no filter or cursor arguments, so filtering here costs one array pass, where
 * filtering on the server would cost two Railway round trips per keystroke to compute the
 * same answer.
 *
 * Selection lives in the URL and is written without a navigation; see
 * use-container-filters for why that is safe in this version of Next and what it buys.
 */
export function ContainerList({
  containers,
  projectId,
  environmentId,
  heading,
  metrics,
  volumes,
}: {
  containers: Container[];
  projectId: string;
  environmentId: string;
  heading: string;
  /** Keyed by service id; empty when Railway refused or had nothing to report. */
  metrics: Record<string, ContainerMetrics>;
  /** Keyed by service id; only containers that have a volume appear in it. */
  volumes: Record<string, ContainerVolume>;
}) {
  const t = useTranslations("dashboard");
  const tFilters = useTranslations("filters");
  const tContainers = useTranslations("containers");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const {
    filters,
    draft,
    setDraft,
    flushDraft,
    setStatuses,
    setOwners,
    setSort,
    clear,
  } = useContainerFilters();

  const matched = useMemo(() => {
    const narrowed = filterContainers(containers, filters);
    return orderContainers(narrowed, filters.sort, locale);
  }, [containers, filters, locale]);

  const listKey = filterKey(filters);

  const { visible, hasMore, paged, loadMore, sentinelRef } = useIncrementalList(
    matched,
    listKey,
  );

  const filtered = hasActiveFilters(filters);
  const selectable = useMemo(() => matched.filter((c) => c.managed), [matched]);
  const managed = selectable.length;

  /*
   * Which rows are ticked, and deliberately not in the URL.
   *
   * ADR-7 puts the list's filters there because a filtered list is worth sharing; a set of
   * containers somebody is about to destroy is the opposite of that. It is also the one piece
   * of state here that must not survive a reload — a link that arrives with six services
   * pre-selected for deletion is a link worth being suspicious of.
   *
   * Reset on the list key, using the derive-during-render pattern useIncrementalList uses for
   * the page count and for the same reason: an effect would commit one render on the old
   * selection first. Changing what you are looking at clears what you had picked, which is
   * both predictable and what keeps a row hidden by a filter out of the batch.
   */
  const EMPTY_SELECTION: ReadonlySet<string> = useMemo(() => new Set(), []);
  const [selection, setSelection] = useState({ key: listKey, ids: new Set<string>() });
  if (selection.key !== listKey) setSelection({ key: listKey, ids: new Set() });
  /*
   * The stale set, for the one render between the key changing and the update above
   * landing. Memoised rather than a fresh `new Set()` per render, because it feeds the
   * `selected` memo below — an inline literal would give that memo a new dependency
   * identity every time and turn it into a no-op.
   */
  const selectedIds = selection.key === listKey ? selection.ids : EMPTY_SELECTION;

  /*
   * The selection as containers, derived rather than stored.
   *
   * Intersected with `selectable` on every render, so a row that has been destroyed, filtered
   * away or turned out not to be ours cannot reach the confirmation — the set of ids is a
   * record of what was ticked, and this is the answer to what that currently means. Ordered
   * by the list rather than by click order, so the dialog reads in the order on screen.
   */
  const selected = useMemo(
    () => selectable.filter((c) => selectedIds.has(c.serviceId)),
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
   * Select-all reaches the matched set, not the page on screen.
   *
   * That is the set the summary sentence counts and the set the filters describe, so it is
   * the set "all" means here — a checkbox that silently meant "the twenty rows rendered so
   * far" would depend on how far the reader had scrolled.
   *
   * Capped at what one request may carry. The count line says so when it bites, because a
   * tick that quietly selected fifty of eighty is the list telling the user something untrue
   * about their own selection.
   */
  const capped = selectable.slice(0, LIMITS.BULK_DESTROY_MAX);
  const allSelected = capped.length > 0 && selected.length === capped.length;
  const selectAll = (checked: boolean) =>
    setSelection({
      key: listKey,
      ids: new Set(checked ? capped.map((c) => c.serviceId) : []),
    });

  const selectedVolumeCount = selected.filter(
    (c) => volumes[c.serviceId] !== undefined,
  ).length;

  /*
   * The sentence describes what is on screen.
   *
   * Unfiltered and unpaged, that is the original count and the original wording — the
   * catalog still carries no zero form, so the guard at zero is what keeps that promise
   * (see the comment this replaced in container-section.tsx). Once anything is hidden,
   * three numbers are genuinely needed, and `managed` counts the matched set rather than
   * the environment so the clauses cannot contradict each other.
   */
  const summary = (() => {
    if (matched.length === 0) return null;
    if (!filtered && !paged) {
      return t("createdHere", { managed, total: matched.length });
    }
    return t("listSummary", {
      shown: visible.length,
      matched: matched.length,
      managed,
    });
  })();

  /*
   * What the containers created here are using, added up.
   *
   * Over `matched` rather than `containers`, so the total describes the same set the
   * sentence above it counts — a filtered list whose total covered the whole environment
   * would be two numbers on one line that disagree.
   */
  const totals = useMemo(
    () => sumContainerMetrics(matched, metrics),
    [matched, metrics],
  );
  const totalCpu = formatVcpu(totals.cpuCores, locale);
  const totalMemory = formatMemoryGb(totals.memoryGb, locale);

  /*
   * Rendered only when something actually answered. Nothing running, metrics refused, or a
   * project with no containers of ours all produce the same nothing here — and a line
   * reading "— vCPU and — across 0 containers" is a sentence with no content, where the
   * per-row em dash at least sits under a label that explains it.
   */
  const totalsSentence =
    totalCpu && totalMemory
      ? t("containerTotals", {
          /*
           * A summed trace is still a trace: twenty containers each below a hundredth of a
           * core add up to something the two-decimal format still cannot show, and "0.00
           * vCPU across 20 containers" is the same false reading the per-row figure had.
           */
          cpu: totalCpu.trace
            ? tCommon("lessThan", { value: totalCpu.value })
            : totalCpu.value,
          memory:
            totalMemory.unit === "gb"
              ? tContainers("memoryValueGb", { value: totalMemory.value })
              : tContainers("memoryValueMb", { value: totalMemory.value }),
          count: totals.containers,
        })
      : null;

  return (
    // A div, not a section: ContainerSection is already the landmark, and a nested one
    // would put a second unnamed region in the outline for the same content.
    <div className="space-y-3">
      <ContainerSectionHeader
        heading={heading}
        summary={
          <>
            <Text asChild variant="caption" tone="subtle">
              {/*
                A bare live region, not role="status": toasts and Banner already own that
                role, and a third source makes every status assertion ambiguous (see
                ui/misc.tsx). It stays mounted and empty rather than appearing with its
                text, which is the classic way an announcement is dropped. The debounce is
                what keeps it to one announcement per settle rather than one per keystroke.
              */}
              <LiveRegion as="p">{summary}</LiveRegion>
            </Text>
            {/*
              Outside the live region on purpose. These numbers move on every metrics
              refresh, and inside they would be announced each time — the announcement spam
              live-region.tsx's debounce exists to prevent, arriving from a different
              direction. The count sentence above is the one worth interrupting for.
            */}
            {totalsSentence && (
              <Text asChild variant="caption" tone="subtle">
                <p>{totalsSentence}</p>
              </Text>
            )}
          </>
        }
      />

      <ContainerFilterBar
        filters={filters}
        draft={draft}
        onDraftChange={setDraft}
        onFlushDraft={flushDraft}
        onStatusesChange={setStatuses}
        onOwnersChange={setOwners}
        onSortChange={setSort}
        onClear={clear}
        canClear={filtered}
      />

      <Card>
        {matched.length === 0 ? (
          <EmptyState
            title={tFilters("noMatchesTitle")}
            description={tFilters("noMatchesDescription")}
            action={
              <Button variant="secondary" size="sm" onClick={clear}>
                {tFilters("clear")}
              </Button>
            }
          />
        ) : (
          <>
            {/*
              The selection toolbar, rendered whenever there is anything here this app could
              destroy — never appearing with the selection itself.

              A toolbar that arrived on the first tick would push the list down at the exact
              moment the pointer was over a row checkbox, so the second tick would land on a
              different row. The filter bar's Clear button settles the same question the same
              way, and its docblock is where the argument is written out.

              Outside the <ul> below on purpose: e2e/support.ts finds a container by filtering
              that list's listitems, so anything inside it is matchable as a row.
            */}
            {managed > 0 && (
              <div className="border-border flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2">
                <Checkbox
                  label={t("selectAll")}
                  checked={allSelected}
                  /*
                   * Some but not all — the third state, drawn by the platform. Without it a
                   * partial selection reads as an empty one, and the box's own tick is the
                   * only thing on the row that says which way pressing it will go.
                   */
                  indeterminate={selected.length > 0 && !allSelected}
                  onChange={(event) => selectAll(event.target.checked)}
                />

                <Text asChild variant="caption" tone="subtle">
                  {/*
                    Inside a live region, unlike the usage total above: this changes only when
                    the reader does something, and it is the confirmation that the something
                    landed — which is exactly what a keyboard user ticking a box they cannot
                    see needs to hear.
                  */}
                  <LiveRegion as="p" className="mr-auto">
                    {selected.length === 0
                      ? t("selectionNone")
                      : selected.length === LIMITS.BULK_DESTROY_MAX &&
                          selectable.length > LIMITS.BULK_DESTROY_MAX
                        ? t("selectionCapped", { count: selected.length })
                        : t("selectionCount", { count: selected.length })}
                  </LiveRegion>
                </Text>

                <BulkDestroyDialog
                  containers={selected}
                  projectId={projectId}
                  environmentId={environmentId}
                  volumeCount={selectedVolumeCount}
                  onDestroyed={() => setSelection({ key: listKey, ids: new Set() })}
                />
              </div>
            )}

            {/*
              Named so the list is distinguishable from other lists on the page — the
              toast viewport is also a list. Rows and nothing else: e2e/support.ts finds
              a container by filtering this list's listitems by text, so a sentinel or a
              footer inside it would be matchable as a row.
            */}
            <ul aria-label={t("containersListLabel")}>
              {visible.map((container) => (
                <ContainerRow
                  key={container.serviceId}
                  container={container}
                  projectId={projectId}
                  environmentId={environmentId}
                  metrics={metrics[container.serviceId]}
                  volume={volumes[container.serviceId]}
                  selected={selectedIds.has(container.serviceId)}
                  /*
                   * Handed only to the rows that can be acted on. An unmanaged row gets no
                   * handler and therefore no checkbox — the decision is made once, here,
                   * rather than by each row re-deriving it.
                   */
                  {...(container.managed
                    ? {
                        onSelectedChange: (checked: boolean) =>
                          setSelected(container.serviceId, checked),
                      }
                    : {})}
                />
              ))}
            </ul>

            <div className="flex flex-col items-center gap-2 px-4 py-3 empty:hidden">
              {/* Zero-height tripwire the observer watches, placed inside the card so it
                  scrolls with the last row. */}
              {hasMore && <div ref={sentinelRef} aria-hidden className="h-px w-full" />}

              {hasMore ? (
                /*
                 * Rendered whenever there is more, not only where autoload has failed.
                 * An observer-driven list is unreachable by keyboard — there is no way
                 * to page without a scroll gesture — so this is the accessible path
                 * through the list rather than a fallback for a broken one.
                 */
                <Button variant="secondary" size="sm" onClick={loadMore}>
                  {t("loadMore")}
                </Button>
              ) : (
                paged && (
                  <Text asChild variant="caption" tone="subtle">
                    <p>{filtered ? t("endOfFilteredList") : t("endOfList")}</p>
                  </Text>
                )
              )}
            </div>
          </>
        )}
      </Card>

      {/* Mounted with the list rather than in page.tsx: this is the only thing on the
          dashboard long enough to need it, and page.tsx is excluded from coverage. */}
      <ScrollToTop />
    </div>
  );
}
