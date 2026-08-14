"use client";

import { ChevronDown, ChevronUp, Copy, Download, Search, WrapText } from "lucide-react";
import { useTranslations } from "next-intl";
import { ToggleGroup } from "radix-ui";
import { UI } from "@/lib/constants";
import { chip } from "./ui/chip";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { LiveRegion } from "./ui/live-region";
import { Text } from "./ui/text";

/**
 * The log pane's controls: find, wrap, copy, download, and filter by severity.
 *
 * Presentational and fully controlled — every piece of state lives in log-pane.tsx,
 * because the pane's autoscroll effects have to read the same values and a control strip
 * that owned half of them would be two sources of truth for one pane.
 *
 * It sits OUTSIDE the role="log" viewport and must stay there: a control inside a live
 * region is re-announced every time the region changes, which for a build emitting
 * hundreds of lines is once a tick.
 *
 * Imported only from log-pane.tsx, which is loaded through next/dynamic. That is what
 * keeps this file and its six icons out of /dashboard's first load, and it is why the
 * skeleton reserves the row by hand instead of rendering this.
 */
export function LogPaneToolbar({
  needle,
  onNeedleChange,
  onNext,
  onPrevious,
  counter,
  counterId,
  matchCount,
  wrap,
  onWrapChange,
  onCopy,
  onDownload,
  canExport,
  severities,
  selected,
  onSelectedChange,
}: {
  needle: string;
  onNeedleChange: (value: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  /** Already-resolved copy; the pane owns the three states it can be in. */
  counter: string;
  counterId: string;
  matchCount: number;
  wrap: boolean;
  onWrapChange: (wrap: boolean) => void;
  onCopy: () => void;
  onDownload: () => void;
  canExport: boolean;
  /** The severities present in the buffer. Empty means no filter is rendered at all. */
  severities: string[];
  selected: string[];
  onSelectedChange: (severities: string[]) => void;
}) {
  const t = useTranslations("containers");

  return (
    <div
      /*
       * A group, not role="toolbar". The toolbar pattern promises arrow-key navigation
       * between its controls, which this does not implement — the severity strip has its
       * own roving tabindex from ToggleGroup and the rest are ordinary tab stops.
       * Claiming a role you do not honour is worse than not claiming it.
       */
      role="group"
      aria-label={t("logToolbarLabel")}
      className="mb-2 flex flex-col gap-2"
    >
      <div className="flex items-center gap-1.5">
        <div className="relative min-w-0 grow">
          <Search
            aria-hidden
            className="text-text-subtle pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
          />
          <Input
            type="search"
            value={needle}
            maxLength={UI.LOG_QUERY_MAX}
            aria-label={t("logSearchLabel")}
            aria-describedby={counterId}
            placeholder={t("logSearchPlaceholder")}
            onChange={(event) => onNeedleChange(event.target.value)}
            onKeyDown={(event) => {
              // The find-bar convention, and the same shape container-filter-bar uses:
              // Enter is only intercepted when it would do something.
              if (event.key === "Enter" && matchCount > 0) {
                event.preventDefault();
                if (event.shiftKey) onPrevious();
                else onNext();
              }
              if (event.key === "Escape") onNeedleChange("");
            }}
            className="pl-9"
          />
        </div>

        {/*
          Described by, and live.

          role="log" on the viewport is already a polite region, so a second one firing
          per keystroke alongside one firing per log line would be unusable — which is why
          the pane sets aria-busy on the viewport while a needle is present. The
          aria-describedby link means a screen reader user hears the count on focusing the
          field, not only when it changes.
        */}
        <LiveRegion
          id={counterId}
          className="text-caption text-text-muted shrink-0 tabular-nums"
        >
          {counter}
        </LiveRegion>

        {/*
          Always mounted, disabled when there is nothing to step through — the rule
          container-filter-bar's Clear button documents. A control that appears is a
          control that reflows the row at the moment the user is aiming at something else.
        */}
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("logPreviousMatch")}
          disabled={matchCount === 0}
          onClick={onPrevious}
        >
          <ChevronUp aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("logNextMatch")}
          disabled={matchCount === 0}
          onClick={onNext}
        >
          <ChevronDown aria-hidden />
        </Button>

        {/*
          aria-pressed on a button rather than a Radix Toggle. This is one two-state
          control, not a group, and the platform already has the semantics — Toggle would
          be machinery for something a button attribute says exactly.
        */}
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("logWrapLines")}
          aria-pressed={wrap}
          onClick={() => onWrapChange(!wrap)}
        >
          <WrapText aria-hidden />
        </Button>

        <Button
          variant="ghost"
          size="sm"
          aria-label={t("logCopy")}
          disabled={!canExport}
          onClick={onCopy}
        >
          <Copy aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("logDownload")}
          disabled={!canExport}
          onClick={onDownload}
        >
          <Download aria-hidden />
        </Button>
      </div>

      {/*
        Built from what arrived, not from a vocabulary this app invented.

        Railway's `severity` is requested by every log document and has never been observed
        carrying a value, so a fixed info/warn/error strip would most likely be a permanent
        row of dead controls. When the buffer holds no severity this renders nothing at all.

        ToggleGroup for the roving tabindex — the strip is one tab stop and arrow keys walk
        it — and it costs no bundle weight, since ThemeToggle already puts it in every
        route's graph.
      */}
      {severities.length > 0 && (
        <ToggleGroup.Root
          type="multiple"
          value={selected}
          onValueChange={onSelectedChange}
          aria-label={t("logSeverityLabel")}
          className="flex flex-wrap gap-1.5"
        >
          {severities.map((severity) => (
            <Text key={severity} asChild variant="badge" tone="inherit">
              <ToggleGroup.Item value={severity} className={chip({ selectable: true })}>
                {severity}
              </ToggleGroup.Item>
            </Text>
          ))}
        </ToggleGroup.Root>
      )}
    </div>
  );
}
