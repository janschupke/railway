"use client";

import { useMemo } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  filterContainers,
  filterKey,
  hasActiveFilters,
  orderContainers,
} from "@/lib/container-filters";
import { sumContainerMetrics } from "@/lib/container-metrics";
import { formatMemoryGb, formatVcpu } from "@/lib/format";
import type { Container, ContainerMetrics, ContainerVolume } from "@/lib/railway/types";
import { useBulkSelection } from "@/hooks/use-bulk-selection";
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
import { Tooltip } from "./ui/tooltip";
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

  // `clear` is already the filter bar's reset, so this one says what it clears.
  const {
    selected,
    setSelected,
    selectAll,
    allSelected,
    capped,
    isSelected,
    clear: clearSelection,
  } = useBulkSelection(selectable, listKey);

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
   * What the containers created here are using, added up — and, beside it, what everything
   * in this environment is using.
   *
   * The first is over `matched` rather than `containers`, so it describes the same set the
   * count above it names: a filtered list whose total covered the whole environment would
   * be two numbers in one tooltip that disagree. The second is deliberately over
   * `containers`, unfiltered and unrestricted, and that is the whole reason it exists — a
   * figure with nothing beside it is a figure nobody can tell is large.
   *
   * Both are environment totals. There is no per-project or per-service monetary figure
   * anywhere in Railway's schema; the only money in this app is `spend`, on the Billing
   * tab, and it covers a whole workspace. See WorkspaceSpend.
   */
  const totals = useMemo(
    () => sumContainerMetrics(matched, metrics),
    [matched, metrics],
  );
  const overall = useMemo(
    () => sumContainerMetrics(containers, metrics, { managedOnly: false }),
    [containers, metrics],
  );

  /*
   * One reading, formatted, or null when nothing answered.
   *
   * Null rather than zero, which is the invariant `sumContainerMetrics` starts its
   * accumulators at null to preserve: nothing running, metrics refused, and an environment
   * with no containers all produce the same nothing here, and "0.00 vCPU across 0
   * containers" would state that infrastructure is running and idle — a claim about
   * somebody's bill. The tooltip says so in words instead.
   */
  const readout = (figures: typeof totals) => {
    const cpu = formatVcpu(figures.cpuCores, locale);
    const memory = formatMemoryGb(figures.memoryGb, locale);
    if (!cpu || !memory) return null;

    return t("usageFigures", {
      /*
       * A summed trace is still a trace: twenty containers each below a hundredth of a
       * core add up to something the two-decimal format still cannot show, and "0.00
       * vCPU across 20 containers" is the same false reading the per-row figure had.
       */
      cpu: cpu.trace ? tCommon("lessThan", { value: cpu.value }) : cpu.value,
      memory:
        memory.unit === "gb"
          ? tContainers("memoryValueGb", { value: memory.value })
          : tContainers("memoryValueMb", { value: memory.value }),
      count: figures.containers,
    });
  };

  const createdHereUsage = readout(totals);
  const overallUsage = readout(overall);

  return (
    // A div, not a section: ContainerSection is already the landmark, and a nested one
    // would put a second unnamed region in the outline for the same content.
    <div className="space-y-3">
      <ContainerSectionHeader
        heading={heading}
        summary={
          <Text asChild variant="caption" tone="subtle">
            {/*
              A bare live region, not role="status": toasts and Banner already own that
              role, and a third source makes every status assertion ambiguous (see
              ui/misc.tsx). It stays mounted and empty rather than appearing with its
              text, which is the classic way an announcement is dropped. The debounce is
              what keeps it to one announcement per settle rather than one per keystroke.
            */}
            <LiveRegion as="p">
              {summary &&
                /*
                 * The usage figures hang off the count rather than sitting under it as a
                 * second line, which is what they used to do. Two captions competing for
                 * one slot read as one sentence continuing, and the numbers are detail
                 * somebody asks for rather than something they need on every glance.
                 *
                 * The button, not the paragraph, is the tooltip trigger. Radix renders
                 * Trigger `asChild`, so it needs one focusable element — a bare `<p>` gives
                 * a tooltip no keyboard user can reach. Putting the button INSIDE the live
                 * region keeps the two roles apart: the region still announces when the
                 * count changes, and the control is a control. Swapping the `<p>` for a
                 * button would move the live region onto the control instead.
                 *
                 * The figures themselves stay out of the announcement, deliberately. They
                 * move on every metrics refresh, and inside a live region that is one
                 * interruption per poll — the spam live-region.tsx's debounce exists to
                 * prevent, arriving from a different direction. Radix mounts tooltip
                 * content only while open, so a reader hears them when they ask.
                 */
                (createdHereUsage || overallUsage ? (
                  <Tooltip
                    wide
                    content={
                      <span className="flex flex-col gap-1.5">
                        <span className="flex flex-col">
                          {/*
                            `badge`, which is the catalogued 12px medium — the tooltip's own
                            text is already `text-caption`, and these two lines are what
                            makes a figure attributable to a scope rather than floating.
                          */}
                          <Text asChild variant="badge">
                            <strong>{t("usageHere")}</strong>
                          </Text>
                          <span>{createdHereUsage ?? t("usageUnknown")}</span>
                        </span>
                        <span className="flex flex-col">
                          <Text asChild variant="badge">
                            <strong>{t("usageOverall")}</strong>
                          </Text>
                          <span>{overallUsage ?? t("usageUnknown")}</span>
                        </span>
                      </span>
                    }
                  >
                    <button
                      type="button"
                      className="focus-ring cursor-help rounded-xs text-left underline decoration-dotted underline-offset-2"
                    >
                      {summary}
                    </button>
                  </Tooltip>
                ) : (
                  summary
                ))}
            </LiveRegion>
          </Text>
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
                      : selected.length === capped.length &&
                          selectable.length > capped.length
                        ? t("selectionCapped", { count: selected.length })
                        : t("selectionCount", { count: selected.length })}
                  </LiveRegion>
                </Text>

                <BulkDestroyDialog
                  containers={selected}
                  projectId={projectId}
                  environmentId={environmentId}
                  volumeCount={selectedVolumeCount}
                  onDestroyed={clearSelection}
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
                  selected={isSelected(container.serviceId)}
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
