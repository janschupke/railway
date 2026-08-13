"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { filterContainers, filterKey, hasActiveFilters } from "@/lib/container-filters";
import type { Container } from "@/lib/railway/types";
import { useContainerFilters } from "@/hooks/use-container-filters";
import { useIncrementalList } from "@/hooks/use-incremental-list";
import { ContainerFilterBar } from "./container-filter-bar";
import { ContainerRow } from "./container-row";
import { ContainerSectionHeader } from "./container-section-header";
import { ScrollToTop } from "./scroll-to-top";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
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
}: {
  containers: Container[];
  projectId: string;
  environmentId: string;
  heading: string;
}) {
  const t = useTranslations("dashboard");
  const tFilters = useTranslations("filters");
  const { filters, draft, setDraft, flushDraft, setStatuses, setOwners, clear } =
    useContainerFilters();

  const matched = useMemo(
    () => filterContainers(containers, filters),
    [containers, filters],
  );

  const { visible, hasMore, paged, loadMore, sentinelRef } = useIncrementalList(
    matched,
    filterKey(filters),
  );

  const filtered = hasActiveFilters(filters);
  const managed = matched.filter((c) => c.managed).length;

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
            <LiveRegion as="p">{summary}</LiveRegion>
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
