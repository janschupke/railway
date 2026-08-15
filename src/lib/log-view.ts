import type { LogLine } from "./railway/types";
import { LIMITS, UI } from "./constants";

/**
 * The log pane's view model: what narrows, what matches, and what leaves the app.
 *
 * Pure and React-free, for the same reason container-filters.ts is: the component that
 * renders a highlighted row and the button that copies the buffer must agree on what
 * "matching" and "visible" mean, and the whole model is then unit-testable in the node
 * project rather than through jsdom.
 *
 * The two browser side effects this feature needs — the clipboard write and the object
 * URL — deliberately do NOT live here. They need a document, which the node project does
 * not have, so they sit beside their only caller in log-pane.tsx.
 */

/**
 * Severity, loudest last.
 *
 * A guess about Railway's wording, not about the shape: all four documents in
 * operations.ts request `severity` and LogLine has carried the field since, but no value
 * has ever been observed — the E2E fixture does not set one either. Anything not on this
 * ladder is kept and sorted alphabetically after it, the same posture toContainerState
 * takes with a Railway enum member this app does not map.
 */
const SEVERITY_ORDER = [
  "trace",
  "debug",
  "info",
  "notice",
  "warn",
  "warning",
  "error",
  "critical",
  "fatal",
] as const;

/**
 * Which of four tones a line is drawn in, or null for the ones that take the pane's own.
 *
 * The ladder above is the vocabulary; this is the only thing that reads a severity for
 * anything other than filtering. Four buckets rather than nine colours, because the
 * question a reader is asking of a log is "is this a problem", and nine answers to it is a
 * legend rather than a signal.
 *
 * Returns a tone name and never a colour: globals.css owns the mapping, keyed on a
 * `data-severity` attribute, exactly as `data-state-color` does for the status badge. That
 * is what keeps this file React-free and the palette in one place.
 *
 * **Driven only by what Railway sends.** No pattern-matching on the message: a line reading
 * `retrying after error` is not an error line, and a heuristic that tints it is a wrong
 * answer delivered confidently. Railway requests `severity` on all four log documents and
 * has never been observed populating it, so this renders no colour against the live API
 * today — the same property the severity filter strip already has, and for the same reason.
 */
export function severityTone(line: LogLine): "muted" | "warning" | "danger" | null {
  const value = line.severity?.trim().toLowerCase();
  if (!value) return null;
  if (value === "trace" || value === "debug") return "muted";
  if (value === "warn" || value === "warning") return "warning";
  if (value === "error" || value === "critical" || value === "fatal") return "danger";
  // info, notice, and anything off the ladder: the pane's own text colour, unchanged.
  return null;
}

/**
 * The severities actually present in the buffer, in reading order.
 *
 * Adaptive because the payload is unknown territory. The control is built from what
 * arrives rather than from a vocabulary this app invented, and when nothing arrives the
 * caller renders no control at all — a filter with no values is furniture.
 *
 * Returns nothing above UI.LOG_SEVERITY_MAX distinct values: if `severity` turns out to
 * be free-form rather than an enum, a thousand lines could yield hundreds of them and the
 * toolbar would become the page. A control that declines when its premise is false beats
 * one that explodes.
 */
export function bufferSeverities(lines: LogLine[]): string[] {
  const seen = new Set<string>();
  for (const line of lines) {
    const value = line.severity?.trim().toLowerCase();
    if (value) seen.add(value);
    if (seen.size > UI.LOG_SEVERITY_MAX) return [];
  }

  const rank = (value: string) => SEVERITY_ORDER.indexOf(value as never);
  return [...seen].sort((a, b) => {
    const [left, right] = [rank(a), rank(b)];
    if (left === -1 && right === -1) return a.localeCompare(b);
    if (left === -1) return 1;
    if (right === -1) return -1;
    return left - right;
  });
}

/**
 * The lines a selection leaves on screen.
 *
 * Returns the input array BY IDENTITY when nothing is selected, which the caller's memo
 * chain depends on: the common case — no severity anywhere, so no selection possible —
 * must not produce a fresh array per render and invalidate the match index behind it.
 *
 * Generic in the line, so the pane's `BufferedLine` survives the filter. The severity rule
 * reads one field and the identity return hands the same objects back, so widening this
 * costs nothing — but narrowing to `LogLine` would strip the id every row is keyed on.
 */
export function visibleLines<T extends LogLine>(lines: T[], severities: string[]): T[] {
  if (severities.length === 0) return lines;
  return lines.filter((line) => {
    const value = line.severity?.trim().toLowerCase();
    return Boolean(value) && severities.includes(value as string);
  });
}

/** One occurrence inside one line's message, with its position in the whole buffer. */
export type LineMatch = { start: number; end: number; ordinal: number };

export type MatchIndex = {
  total: number;
  /** Line index → its occurrences. Absent for a line with none. */
  byLine: Map<number, LineMatch[]>;
  /** Ordinal → line index, which is what next/previous navigates over. */
  lineOf: number[];
};

const EMPTY_INDEX: MatchIndex = { total: 0, byLine: new Map(), lineOf: [] };

/**
 * Case-insensitive literal occurrences of `needle`, indexed three ways in one pass.
 *
 * `indexOf`, not `RegExp`. A log search needle is routinely a fragment of a stack trace
 * or a path — `.*`, `[`, `(` and `\` are ordinary characters in it, and a regex would
 * either throw on them or match something the reader did not ask for. Escaping the needle
 * would work and buys nothing here, since none of the features of a regex are wanted.
 *
 * Below UI.LOG_SEARCH_MIN_CHARS this returns nothing. That bound is on the DOM rather
 * than on the scan: one character matches most of a thousand buffered lines, which is
 * tens of thousands of <mark> elements built per keystroke for a result that tells the
 * reader nothing.
 */
export function indexMatches(lines: LogLine[], needle: string): MatchIndex {
  const wanted = needle.trim();
  if (wanted.length < UI.LOG_SEARCH_MIN_CHARS) return EMPTY_INDEX;

  const byLine = new Map<number, LineMatch[]>();
  const lineOf: number[] = [];
  const target = wanted.toLowerCase();

  lines.forEach((line, index) => {
    const message = line.message ?? "";
    /*
     * Lowercasing can change a string's LENGTH — "İ" is one code point that lowercases to
     * two — and an offset into the lowered string would then land mid-glyph in the
     * original, highlighting the wrong characters with nothing visibly wrong in review.
     * When the assumption does not hold, scan the original case-sensitively: fewer hits
     * on a line nobody has, rather than wrong hits on a line someone is reading.
     */
    const lowered = message.toLowerCase();
    const exact = lowered.length !== message.length;
    const haystack = exact ? message : lowered;
    const seek = exact ? wanted : target;

    const found: LineMatch[] = [];
    let from = haystack.indexOf(seek);
    while (from !== -1) {
      found.push({ start: from, end: from + seek.length, ordinal: lineOf.length });
      lineOf.push(index);
      from = haystack.indexOf(seek, from + seek.length);
    }
    if (found.length > 0) byLine.set(index, found);
  });

  return { total: lineOf.length, byLine, lineOf };
}

/** A stretch of one message: inside a match (with its ordinal) or between them. */
export type Run = { text: string; ordinal: number | null };

/**
 * A message split into highlighted and plain stretches.
 *
 * A line with no matches yields exactly one run, so an unmatched row renders a single
 * text node — the same DOM it produced before this feature existed.
 */
export function highlightRuns(
  message: string,
  matches: LineMatch[] | undefined,
): Run[] {
  if (!matches || matches.length === 0) return [{ text: message, ordinal: null }];

  const runs: Run[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) {
      runs.push({ text: message.slice(cursor, match.start), ordinal: null });
    }
    runs.push({ text: message.slice(match.start, match.end), ordinal: match.ordinal });
    cursor = match.end;
  }
  if (cursor < message.length) {
    runs.push({ text: message.slice(cursor), ordinal: null });
  }
  return runs;
}

/**
 * The buffer as a text file.
 *
 * Full ISO timestamps, not the eight-character clock the pane draws. This text leaves the
 * app — into an issue, a paste, a file — where the date and the offset are exactly what a
 * reader needs and the pane's clock has already thrown away. A line carrying no timestamp
 * carries none here either: "--:--:--" is an affordance, not data.
 *
 * Severity is included when the line has one, because it is something the line actually
 * holds rather than something this app decided about it — and by the time a reader is
 * exporting, the filter chips have already made it information they are using.
 */
export function serializeLines(lines: LogLine[]): string {
  if (lines.length === 0) return "";
  return lines
    .map((line) =>
      [line.timestamp, line.severity?.trim().toUpperCase(), line.message]
        .filter(Boolean)
        .join(" "),
    )
    .join("\n")
    .concat("\n");
}

/** Used when a container's name slugs away to nothing. Protocol, not copy. */
const FALLBACK_SLUG = "container";

/**
 * `cache-logs-2026-08-13T09-41-02.txt`.
 *
 * Named after the container because a file called `logs.txt` in a Downloads folder is
 * indistinguishable from the last four, and stamped because a reader downloading twice
 * during one build wants both. `at` is a parameter rather than a `new Date()` inside, the
 * same shape relativeTime takes its clock, so the result is deterministic under test.
 */
export function logFileName(label: string, at: Date): string {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, LIMITS.CONTAINER_NAME_MAX)
      .replace(/-+$/, "") || FALLBACK_SLUG;
  const stamp = at.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${slug}-logs-${stamp}.txt`;
}
