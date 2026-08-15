"use client";

import { memo } from "react";
import { highlightRuns, severityTone, type LineMatch } from "@/lib/log-view";
import { cn } from "@/lib/utils";
import type { BufferedLine } from "@/hooks/use-deployment-stream";

/**
 * One line, memoised.
 *
 * `matches` comes straight out of the match index and is referentially stable across any
 * render that does not rebuild it, so stepping to the next match re-renders two rows out
 * of a thousand rather than all of them. `current` is the ordinal this row holds, or -1.
 *
 * highlightRuns is called in here rather than in the map above, so a line with no matches
 * does no string work at all.
 */
export const LogRow = memo(function LogRow({
  line,
  matches,
  current,
  wrap,
  noTimestamp,
}: {
  line: BufferedLine;
  matches: LineMatch[] | undefined;
  current: number;
  wrap: boolean;
  noTimestamp: string;
}) {
  const tone = severityTone(line);

  return (
    <div
      data-log-row
      /*
       * The row's colour is a token lookup in globals.css keyed on this attribute, the
       * same mechanism StatusBadge uses — omitted entirely when there is no tone, so the
       * row inherits the pane's text colour rather than being painted with it.
       */
      {...(tone ? { "data-severity": tone } : {})}
      className={cn(
        "text-text",
        // break-all is not optional. Radix wraps the viewport's children in a
        // `min-width:100%; display:table` box, which is shrink-to-fit, so a single
        // unbreakable token — a URL, a base64 blob — would keep the horizontal scrollbar
        // alive and leave "wrap" visibly not wrapping.
        wrap ? "break-all whitespace-pre-wrap" : "whitespace-pre",
      )}
    >
      {/*
        Selectable, and it used to not be.

        `select-none` here meant a hand selection yielded messages without their times,
        on the argument that a pasted excerpt reads better as the log than as a column of
        clock times. That is a real preference and it was the wrong one to enforce: the
        commonest reason to drag-select two log lines is to say when something happened,
        and there was no way to get the times out short of copying the whole buffer.
        Anyone who wants the messages alone can still select from the first glyph of one.
      */}
      <span className="text-text-subtle mr-2">
        {/* `||`, not `??`: an empty timestamp slices to "" and must
            still fall back to the placeholder. */}
        {line.timestamp?.slice(11, 19) || noTimestamp}
      </span>
      {highlightRuns(line.message, matches).map((run, index) =>
        run.ordinal === null ? (
          run.text
        ) : (
          <mark
            key={index}
            data-log-match={run.ordinal === current ? "current" : "other"}
            /*
             * <mark> defaults to yellow-on-black in every UA, so both halves are set
             * here. The non-current fill is nearly invisible over the pane's own
             * background — it is the glyph colour that carries it — while the current
             * match takes the opaque accent, which is the loudest thing in the pane.
             *
             * No horizontal padding: this is a monospace column, and px-0.5 would shift
             * every glyph after a match out of alignment with the lines around it.
             */
            className={cn(
              "bg-accent-bg text-accent rounded-sm",
              "data-[log-match=current]:bg-accent data-[log-match=current]:text-accent-fg",
            )}
          >
            {run.text}
          </mark>
        ),
      )}
    </div>
  );
});
