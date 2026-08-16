"use client";

import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  Maximize2,
  Search,
  WrapText,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { ToggleGroup } from "radix-ui";
import { UI } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { chip } from "./ui/chip";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { LiveRegion } from "./ui/live-region";
import { Text } from "./ui/text";
import { Tooltip } from "./ui/tooltip";

/**
 * One of the toolbar's icon buttons.
 *
 * Every control on this row is icon-only, so every one of them needs the same three
 * things and used to have one. `aria-label` names it for a screen reader and for nobody
 * looking at the page; the Tooltip is what a sighted user gets, and it carries the same
 * string so the two cannot drift.
 *
 * The tooltip works on the disabled ones — Previous, Next, Copy, Download are all inert
 * some of the time — only because Button stopped setting `pointer-events-none` when
 * disabled. An element outside hit-testing fires no pointer events, so a Radix tooltip
 * trigger wrapped around one is silent, which is exactly when the label is most wanted:
 * a control that will not act should be able to say why.
 */
function IconButton({
  label,
  icon,
  ...props
}: React.ComponentProps<typeof Button> & { label: string; icon: React.ReactNode }) {
  return (
    <Tooltip content={label}>
      <Button variant="ghost" size="sm" aria-label={label} {...props}>
        {icon}
      </Button>
    </Tooltip>
  );
}

/**
 * The log pane's controls: find, wrap, copy, download, maximise, and filter by severity.
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
 * keeps this file and its icons out of /dashboard's first load, and it is why the
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
  copied,
  downloaded,
  copying,
  canExport,
  maximized,
  onMaximizedChange,
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
  /** The clipboard write succeeded recently enough to still be worth showing. */
  copied: boolean;
  downloaded: boolean;
  /** The clipboard write is in flight. It can block on a permission prompt. */
  copying: boolean;
  canExport: boolean;
  maximized: boolean;
  onMaximizedChange: (maximized: boolean) => void;
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
      {/*
        The gutter is for the dialog's close control, which ./log-pane renders this
        toolbar inside of while maximised. That control is positioned absolutely into
        the top-right corner this row ends in, so without the padding it lands on top
        of whichever button happens to be last — and it paints over them, because the
        dialog draws it after its children. Reserving the space is the fix; removing
        the button that was under it only promotes the next one into the same corner.
      */}
      <div className={cn("flex items-center gap-1.5", maximized && "pr-9")}>
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
        <IconButton
          label={t("logPreviousMatch")}
          icon={<ChevronUp aria-hidden />}
          disabled={matchCount === 0}
          onClick={onPrevious}
        />
        <IconButton
          label={t("logNextMatch")}
          icon={<ChevronDown aria-hidden />}
          disabled={matchCount === 0}
          onClick={onNext}
        />

        {/*
          aria-pressed on a button rather than a Radix Toggle. This is one two-state
          control, not a group, and the platform already has the semantics — Toggle would
          be machinery for something a button attribute says exactly.
        */}
        <IconButton
          label={t("logWrapLines")}
          icon={<WrapText aria-hidden />}
          aria-pressed={wrap}
          onClick={() => onWrapChange(!wrap)}
        />

        {/*
          Copy and download swap to a tick on success, for UI.ACTION_FEEDBACK_MS.

          These are the only two controls in the app that do their whole job without
          changing anything on screen. Both toast, and a toast is the right answer for a
          screen-reader user — it is announced, and it is where a failed clipboard write
          says so. It is the wrong answer on its own for someone whose eyes are on the
          button they just pressed, which is where the confirmation has to appear.

          The pending state on copy is not decoration either: `navigator.clipboard` can
          block on a permission prompt, and a button that looked idle through it read as
          one that had ignored the click.
        */}
        <IconButton
          label={t("logCopy")}
          icon={copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          disabled={!canExport}
          pending={copying}
          onClick={onCopy}
        />
        <IconButton
          label={t("logDownload")}
          icon={downloaded ? <Check aria-hidden /> : <Download aria-hidden />}
          disabled={!canExport}
          onClick={onDownload}
        />

        {/*
          Last on the row, because it is the only control here that does not act on the
          log — it acts on the space the log is read in.

          Absent once maximised, because the dialog already draws a control that does
          this. ./log-pane names its close `logMinimize`, so the restore affordance is
          still there and still carries that name — and keeping this one too would put
          two controls for one action side by side in the same corner. The gutter
          above is the separate half of the fix: it is what stops whichever button is
          last from sitting under the dialog's close, and it is needed whether or not
          this one is rendered.
        */}
        {!maximized && (
          <IconButton
            label={t("logMaximize")}
            icon={<Maximize2 aria-hidden />}
            aria-pressed={false}
            onClick={() => onMaximizedChange(true)}
          />
        )}
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
