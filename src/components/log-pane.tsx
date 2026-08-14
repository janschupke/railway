"use client";

import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslations } from "next-intl";
import { UI } from "@/lib/constants";
import {
  bufferSeverities,
  highlightRuns,
  indexMatches,
  logFileName,
  serializeLines,
  visibleLines,
  type LineMatch,
} from "@/lib/log-view";
import { cn } from "@/lib/utils";
import type { StreamStatus } from "@/hooks/use-deployment-stream";
import type { LogLine } from "@/lib/railway/types";
import { LogPaneToolbar } from "./log-pane-toolbar";
import { ScrollArea } from "./ui/scroll-area";
import { Button } from "./ui/button";
import { Text } from "./ui/text";
import { useToast } from "./ui/toast";

/**
 * The clipboard, or an honest failure.
 *
 * `navigator.clipboard` is undefined on an insecure origin, so the property access itself
 * throws and the catch covers it — no separate feature test is needed. It also rejects on
 * a denied permission and when the document is not focused, and all three are the same
 * thing to the caller: the text did not go anywhere, and the user needs to be told rather
 * than left believing it did.
 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/plain;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on the next task rather than inline: a synchronous revoke can abort the
  // download the click has only just started, and it fails silently — no error, no file.
  setTimeout(() => URL.revokeObjectURL(url));
}

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
const LogRow = memo(function LogRow({
  line,
  matches,
  current,
  wrap,
  noTimestamp,
}: {
  line: LogLine;
  matches: LineMatch[] | undefined;
  current: number;
  wrap: boolean;
  noTimestamp: string;
}) {
  return (
    <div
      data-log-row
      className={cn(
        "text-text",
        // break-all is not optional. Radix wraps the viewport's children in a
        // `min-width:100%; display:table` box, which is shrink-to-fit, so a single
        // unbreakable token — a URL, a base64 blob — would keep the horizontal scrollbar
        // alive and leave "wrap" visibly not wrapping.
        wrap ? "break-all whitespace-pre-wrap" : "whitespace-pre",
      )}
    >
      <span className="text-text-subtle mr-2 select-none">
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

/**
 * Log output with autoscroll that yields to the reader.
 *
 * Scrolling up detaches the tail and surfaces a button to reattach. Tailing that fights
 * the user is worse than no tailing — you cannot read a failure while it scrolls away.
 *
 * Search highlights and navigates; it never hides a line. A log is read for its context,
 * and a needle that filtered would take away the three lines before the failure, which
 * are usually the reason. Severity is the only thing that narrows, and copy and download
 * follow whatever is on screen.
 *
 * Note that the timestamp span is `select-none`, so a hand selection inside the pane
 * yields messages without their timestamps. That is deliberate — a pasted excerpt reads
 * as the log rather than as a column of clock times — and the copy button is the way to
 * get the full ISO stamps.
 */
export function LogPane({
  lines,
  status,
  emptyLabel,
  label,
}: {
  lines: LogLine[];
  status: StreamStatus;
  /** What "connected and quiet" means here; ignored in the other two states. */
  emptyLabel?: string;
  /** The container these lines belong to. Names the downloaded file. */
  label: string;
}) {
  const t = useTranslations("containers");
  const { toast } = useToast();
  const counterId = useId();
  /*
   * A callback ref, not a plain ref object.
   *
   * The listener used to attach in a `[]` effect reading `viewportRef.current`. This
   * component is loaded through next/dynamic and remounts behind the row's `mounted`
   * gate, so the element is not reliably there on the commit that effect runs — and when
   * it was not, the listener never attached at all. Nothing failed: `pinned` simply
   * stayed true forever, so the pane kept scrolling itself while the reader was trying to
   * read, and "Jump to latest" never appeared to say otherwise. A silent wrong answer.
   *
   * The callback-ref-into-state shape is the one use-incremental-list already uses for
   * its sentinel, and for the same reason: the element arrives and departs, and only a
   * callback ref hears about both.
   */
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [attached, setAttached] = useState<HTMLDivElement | null>(null);
  const [pinned, setPinned] = useState(true);

  const [needle, setNeedle] = useState("");
  /*
   * useDeferredValue, not the debounce this repo already has.
   *
   * LIST.SEARCH_DEBOUNCE_MS exists because a keystroke in the container filter bar mounts
   * and unmounts rows, and a mounted row opens an EventSource against
   * STREAM.MAX_CONCURRENT_PER_USER. Here a keystroke costs CPU and nothing else: no
   * request, no connection, no URL write. A fixed quarter-second of lag is the wrong
   * price for a find field, where the expectation is set by the browser's own.
   */
  const deferredNeedle = useDeferredValue(needle);
  const [ordinal, setOrdinal] = useState(0);
  /*
   * A nonce meaning "the user asked to move", separate from which match is current.
   *
   * Only this bumps the scroll-to-match effect, so a log line arriving while the reader
   * is reading does not re-centre the pane under them. Same device as container-row's
   * `intent` ref: a value that records an intention, apart from the value that records
   * what is true.
   */
  const [seek, setSeek] = useState(0);
  const [wrap, setWrap] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  /*
   * Both a ref and a state, deliberately.
   *
   * The ref is what the effects read and mutate: `scrollTop` on a DOM node is not React
   * state, and react-hooks/immutability correctly refuses a write to a value that came
   * out of useState. The state exists only to be a dependency, so the effects re-run on
   * the commit where the element actually arrives.
   */
  const setViewport = useCallback((node: HTMLDivElement | null) => {
    viewportRef.current = node;
    setAttached(node);
  }, []);

  const present = useMemo(() => bufferSeverities(lines), [lines]);
  /*
   * Derived during render, never corrected by an effect.
   *
   * A severity the reader selected can roll out of the 1,000-line buffer, and resetting
   * the selection when it does would forget a choice the user made about a stream that is
   * still running. Filtering it out here means it simply stops narrowing, and starts
   * again if the value comes back. It also makes "filtered to nothing" unreachable, so
   * the three empty states below need no fourth.
   */
  const activeKey = present.filter((severity) => selected.includes(severity)).join(",");
  // Rebuilt from the joined key rather than kept as the filtered array, so its identity
  // changes when the selection does and not on every render — which is what the memo
  // below, and the effects that depend on `visible`, actually key on.
  const active = useMemo(() => (activeKey ? activeKey.split(",") : []), [activeKey]);
  const visible = useMemo(() => visibleLines(lines, active), [lines, active]);
  const index = useMemo(
    () => indexMatches(visible, deferredNeedle),
    [visible, deferredNeedle],
  );
  // Clamped rather than reset in an effect, the same way container-row corrects `phase`
  // during render: a match set that shrank must not render a wrong ordinal first.
  const current = index.total === 0 ? -1 : Math.min(ordinal, index.total - 1);

  const step = (delta: number) => {
    if (index.total === 0) return;
    setOrdinal((previous) => {
      const from = Math.min(previous, index.total - 1);
      return (from + delta + index.total) % index.total;
    });
    setSeek((n) => n + 1);
  };

  const changeNeedle = (value: string) => {
    setNeedle(value);
    setOrdinal(0);
    setSeek((n) => n + 1);
  };

  const changeSelected = (severities: string[]) => {
    setSelected(severities);
    setOrdinal(0);
    setSeek((n) => n + 1);
  };

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el || !pinned) return;
    el.scrollTop = el.scrollHeight;
    // `visible` rather than `lines`: a severity toggle changes the rendered height
    // without `lines` changing. `wrap` for the same reason — a pinned pane must stay
    // pinned across a change that reflows every row.
  }, [visible, pinned, attached, wrap]);

  /*
   * Declared AFTER the autoscroll effect, which is what makes it win.
   *
   * React runs a component's layout effects in declaration order, so on the one commit
   * where both could run — a log frame arriving in the same tick as a jump — this
   * overwrites the scroll to the tail. Doing the scroll imperatively in the click handler
   * would lose that race instead, and mid-build it is not a rare one.
   *
   * offsetTop rather than scrollIntoView: that scrolls every scrollable ancestor
   * including the document, which on a dashboard means the whole page jumps. It is also
   * why setup-dom stubs it to a no-op, so a test using it would prove nothing.
   */
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el || seek === 0) return;
    const mark = el.querySelector<HTMLElement>("[data-log-match='current']");
    if (!mark) return;
    // Navigating detaches the tail. Being yanked back to the bottom mid-read is exactly
    // what this pane's autoscroll rule exists to prevent.
    setPinned(false);
    const row = mark.closest<HTMLElement>("[data-log-row]") ?? mark;
    el.scrollTop = Math.max(
      0,
      row.offsetTop - (el.clientHeight - row.offsetHeight) / 2,
    );
  }, [seek, attached]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      setPinned(distance <= UI.AUTOSCROLL_THRESHOLD_PX);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [attached]);

  const counter =
    needle.trim().length === 0
      ? ""
      : needle.trim().length < UI.LOG_SEARCH_MIN_CHARS
        ? t("logSearchMinChars", { count: UI.LOG_SEARCH_MIN_CHARS })
        : index.total === 0
          ? t("logNoMatches")
          : t("logMatchCount", { index: current + 1, total: index.total });

  const onCopy = async () => {
    if (await writeClipboard(serializeLines(visible))) {
      toast({ title: t("logCopied", { count: visible.length }), tone: "success" });
    } else {
      toast({
        title: t("logCopyFailed"),
        description: t("logCopyFailedDetail"),
        tone: "error",
      });
    }
  };

  return (
    <div className="relative">
      <LogPaneToolbar
        needle={needle}
        onNeedleChange={changeNeedle}
        onNext={() => step(1)}
        onPrevious={() => step(-1)}
        counter={counter}
        counterId={counterId}
        matchCount={index.total}
        wrap={wrap}
        onWrapChange={setWrap}
        onCopy={onCopy}
        onDownload={() =>
          downloadText(logFileName(label, new Date()), serializeLines(visible))
        }
        canExport={visible.length > 0}
        severities={present}
        selected={active}
        onSelectedChange={changeSelected}
      />

      <ScrollArea
        className="bg-subtle h-pane-log rounded-md"
        viewportClassName="p-3"
        viewportRef={setViewport}
        viewportProps={{
          /*
           * `role="log"` carries an implicit aria-live of polite, which is exactly what
           * a build emitting hundreds of lines needs — assertive would be unusable. The
           * explicit attribute was redundant rather than additive, and on a dashboard
           * already holding several regions the cheapest one to remove is the one that
           * says nothing the role does not.
           */
          role: "log",
          "aria-label": t("logsLabel"),
          /*
           * Muted while searching. Changing the needle replaces text nodes with elements
           * across every matching row, and the region's default aria-relevant counts all
           * of that as additions — a burst a screen reader would read out wholesale, on
           * top of the match counter saying the same thing more usefully. Someone who is
           * searching is not tailing, and clearing the field resumes the announcements.
           */
          "aria-busy": needle ? true : undefined,
        }}
      >
        {visible.length === 0 ? (
          <Text asChild variant="mono" tone="muted">
            {/*
              Three states, not two. A stream that closed having emitted nothing has
              finished its job — saying "Connecting…" there is a lie that never resolves,
              which is exactly what a successful deployment with no log output produced.

              Still three with filtering in play: `active` only ever holds severities the
              buffer actually contains, so a filter can never narrow to nothing.
            */}
            <p>
              {status === "connecting"
                ? t("connecting")
                : status === "closed"
                  ? t("noLogOutput")
                  : (emptyLabel ?? t("waitingForOutput"))}
            </p>
          </Text>
        ) : (
          // The mono variant carries its own leading, so these rows, the empty state above
          // and log-pane-skeleton.tsx can no longer disagree about it — which they did,
          // the two placeholders standing in at a tighter line height than the real thing.
          <div className="text-mono font-mono">
            {visible.map((line, i) => (
              <LogRow
                key={`${line.timestamp}-${i}`}
                line={line}
                matches={index.byLine.get(i)}
                current={index.lineOf[current] === i ? current : -1}
                wrap={wrap}
                noTimestamp={t("noTimestamp")}
              />
            ))}
          </div>
        )}
      </ScrollArea>

      {!pinned && (
        <Button
          size="sm"
          onClick={() => setPinned(true)}
          className="absolute right-3 bottom-3 rounded-full shadow-sm"
        >
          {t("jumpToLatest")}
        </Button>
      )}
    </div>
  );
}
