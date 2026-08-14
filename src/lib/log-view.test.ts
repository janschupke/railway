import { describe, expect, it } from "vitest";
import {
  bufferSeverities,
  highlightRuns,
  indexMatches,
  logFileName,
  serializeLines,
  visibleLines,
} from "./log-view";
import { UI } from "./constants";
import type { LogLine } from "./railway/types";

const line = (message: string, severity?: string | null): LogLine => ({
  timestamp: "2026-08-13T09:41:02Z",
  message,
  severity,
});

describe("bufferSeverities", () => {
  it("finds nothing when no line carries one, which is the case that hides the control", () => {
    expect(bufferSeverities([line("boot"), line("ready", null)])).toEqual([]);
  });

  it("folds case and surrounding whitespace into one value", () => {
    expect(bufferSeverities([line("a", "ERROR"), line("b", " error ")])).toEqual([
      "error",
    ]);
  });

  it("orders by loudness, not alphabetically", () => {
    // Alphabetical would put debug above error above info, which is the opposite of
    // what someone scanning for a failure is reaching for.
    expect(
      bufferSeverities([line("a", "info"), line("b", "error"), line("c", "debug")]),
    ).toEqual(["debug", "info", "error"]);
  });

  it("keeps a value it does not recognise, after the ones it does", () => {
    expect(
      bufferSeverities([
        line("a", "zephyr"),
        line("b", "error"),
        line("c", "aardvark"),
      ]),
    ).toEqual(["error", "aardvark", "zephyr"]);
  });

  it("declines entirely once the buffer holds more values than a filter can be", () => {
    // The premise of the adaptive control is that severity is an enum. If Railway ever
    // answers with something free-form, no control is better than hundreds of chips.
    const many = Array.from({ length: UI.LOG_SEVERITY_MAX + 1 }, (_, i) =>
      line(`line ${i}`, `level-${i}`),
    );
    expect(bufferSeverities(many)).toEqual([]);
  });
});

describe("visibleLines", () => {
  it("returns the very same array when nothing is selected", () => {
    // Identity, not equality: the pane's match index memoises on this result, and a
    // fresh array per render would rebuild it on every commit.
    const lines = [line("a", "info"), line("b", "error")];
    expect(visibleLines(lines, [])).toBe(lines);
  });

  it("keeps only the selected severities", () => {
    const lines = [line("a", "info"), line("b", "ERROR"), line("c")];
    expect(visibleLines(lines, ["error"]).map((l) => l.message)).toEqual(["b"]);
  });

  it("drops every line when the selection names something absent", () => {
    const lines = [line("a", "info")];
    expect(visibleLines(lines, ["fatal"])).toEqual([]);
  });
});

describe("indexMatches", () => {
  it("finds nothing below the minimum needle length", () => {
    expect(indexMatches([line("error")], "e").total).toBe(0);
  });

  it("matches without regard to case", () => {
    expect(indexMatches([line("Fatal ERROR")], "error").total).toBe(1);
  });

  it("treats a needle with regex metacharacters literally", () => {
    // A log needle is routinely a fragment of a path or a stack frame. `.*` must find
    // `.*`, not everything, and `[` must not throw.
    const lines = [line("at foo.bar(*)"), line("anything at all")];
    const index = indexMatches(lines, ".b");
    expect(index.total).toBe(1);
    expect(index.lineOf).toEqual([0]);
    expect(indexMatches(lines, "[").total).toBe(0);
  });

  it("finds every occurrence in a line, left to right and non-overlapping", () => {
    const index = indexMatches([line("aaaa")], "aa");
    expect(index.total).toBe(2);
    expect(index.byLine.get(0)).toEqual([
      { start: 0, end: 2, ordinal: 0 },
      { start: 2, end: 4, ordinal: 1 },
    ]);
  });

  it("maps each ordinal back to the line holding it, and omits lines with none", () => {
    const index = indexMatches([line("miss"), line("hit hit"), line("miss")], "hit");
    expect(index.lineOf).toEqual([1, 1]);
    expect(index.byLine.has(0)).toBe(false);
    expect(index.byLine.has(2)).toBe(false);
  });

  it("falls back to a case-sensitive scan when lowercasing changes the length", () => {
    /*
     * "İ" is one code point that lowercases to two, so an offset into the lowered string
     * lands mid-glyph in the original — a highlight one character off, with nothing
     * visibly wrong in review. Fewer hits is the safe direction.
     */
    const index = indexMatches([line("İstanbul error")], "ERROR");
    expect(index.total).toBe(0);
    expect(indexMatches([line("İstanbul error")], "error").total).toBe(1);
  });
});

describe("highlightRuns", () => {
  it("yields a single run for a line with no matches", () => {
    // One text node, which is the DOM this row produced before search existed.
    expect(highlightRuns("plain", undefined)).toEqual([
      { text: "plain", ordinal: null },
    ]);
    expect(highlightRuns("plain", [])).toEqual([{ text: "plain", ordinal: null }]);
  });

  it("splits around a match in the middle", () => {
    expect(highlightRuns("a hit b", [{ start: 2, end: 5, ordinal: 7 }])).toEqual([
      { text: "a ", ordinal: null },
      { text: "hit", ordinal: 7 },
      { text: " b", ordinal: null },
    ]);
  });

  it("handles a match at the very start and at the very end", () => {
    expect(highlightRuns("hit b", [{ start: 0, end: 3, ordinal: 0 }])).toEqual([
      { text: "hit", ordinal: 0 },
      { text: " b", ordinal: null },
    ]);
    expect(highlightRuns("a hit", [{ start: 2, end: 5, ordinal: 0 }])).toEqual([
      { text: "a ", ordinal: null },
      { text: "hit", ordinal: 0 },
    ]);
  });

  it("emits no empty run between two adjacent matches", () => {
    expect(
      highlightRuns("aabb", [
        { start: 0, end: 2, ordinal: 0 },
        { start: 2, end: 4, ordinal: 1 },
      ]),
    ).toEqual([
      { text: "aa", ordinal: 0 },
      { text: "bb", ordinal: 1 },
    ]);
  });
});

describe("serializeLines", () => {
  it("writes the full ISO timestamp, not the clock the pane draws", () => {
    // The eight-character clock is an affordance for a pane 256px tall. A file that
    // leaves the app needs the date and the offset it threw away.
    expect(serializeLines([line("boot")])).toBe("2026-08-13T09:41:02Z boot\n");
  });

  it("includes severity when the line carries one", () => {
    expect(serializeLines([line("boot", "error")])).toBe(
      "2026-08-13T09:41:02Z ERROR boot\n",
    );
  });

  it("writes a line with no timestamp as its message alone", () => {
    expect(serializeLines([{ timestamp: "", message: "orphan" }])).toBe("orphan\n");
  });

  it("produces nothing at all for an empty buffer", () => {
    expect(serializeLines([])).toBe("");
  });
});

describe("logFileName", () => {
  const at = new Date("2026-08-13T09:41:02.123Z");

  it("names the container and stamps the moment", () => {
    expect(logFileName("cache", at)).toBe("cache-logs-2026-08-13T09-41-02.txt");
  });

  it("slugs a name that is not filename material", () => {
    expect(logFileName("My Cache (EU)!", at)).toBe(
      "my-cache-eu-logs-2026-08-13T09-41-02.txt",
    );
  });

  it("falls back when a name slugs away to nothing", () => {
    expect(logFileName("!!!", at)).toBe("container-logs-2026-08-13T09-41-02.txt");
  });

  it("does not leave a trailing dash where it truncated", () => {
    const long = `${"a".repeat(39)} tail`;
    expect(logFileName(long, at)).toBe(
      `${"a".repeat(39)}-logs-2026-08-13T09-41-02.txt`,
    );
  });
});
