import { describe, expect, it } from "vitest";
import {
  dropReattachOverlap,
  expectReplay,
  overlapLength,
  sameLine,
} from "./log-overlap";
import type { LogLine } from "./railway/types";

/**
 * A line whose message is its identity for the reader, and nothing here treats it as one.
 *
 * The timestamp is shared across every line on purpose: it is what Railway does inside a
 * single batch, and a helper that stamped each line differently would make every test in
 * this file pass for the wrong reason.
 */
const line = (message: string, severity?: string | null): LogLine => ({
  timestamp: "2026-08-14T09:41:02Z",
  message,
  severity,
});

/** The case the whole module is built around: output that is genuinely repeated. */
const dot = () => line(".");

describe("sameLine", () => {
  it("compares the whole tuple", () => {
    expect(sameLine(line("boot"), line("boot"))).toBe(true);
    expect(sameLine(line("boot"), line("ready"))).toBe(false);
    expect(sameLine(line("boot", "info"), line("boot", "error"))).toBe(false);
    expect(
      sameLine(
        { timestamp: "2026-08-14T09:41:02Z", message: "boot" },
        { timestamp: "2026-08-14T09:41:03Z", message: "boot" },
      ),
    ).toBe(false);
  });

  it("treats an absent severity and a null one as the same line", () => {
    // Not a tidy-up: the query answers null for a line the subscription sends without the
    // field at all, so the same line arriving through both routes has to compare equal.
    expect(sameLine(line("boot"), line("boot", null))).toBe(true);
  });
});

describe("overlapLength", () => {
  it("finds nothing when the two windows share nothing", () => {
    expect(overlapLength([line("a"), line("b")], [line("c"), line("d")])).toBe(0);
  });

  it("finds the join between two windows over the same history", () => {
    expect(
      overlapLength(
        [line("a"), line("b"), line("c")],
        [line("b"), line("c"), line("d")],
      ),
    ).toBe(2);
  });

  it("takes the largest run, not the first line that happens to match", () => {
    // First-match would answer 1 here, on the leading `a`, and cancel one line of a run
    // that is two long. Both sides are the same query, so the largest is the real offset.
    expect(
      overlapLength(
        [line("a"), line("a"), line("b")],
        [line("a"), line("b"), line("z")],
      ),
    ).toBe(2);
  });

  it("counts a run of identical lines rather than collapsing it", () => {
    expect(overlapLength([dot(), dot(), dot()], [dot(), dot(), dot(), line("x")])).toBe(
      3,
    );
  });

  it("cannot exceed the shorter side", () => {
    expect(overlapLength([line("a")], [line("a"), line("a"), line("a")])).toBe(1);
    expect(overlapLength([line("a"), line("a")], [line("a")])).toBe(1);
  });

  it("is zero against an empty side", () => {
    expect(overlapLength([], [line("a")])).toBe(0);
    expect(overlapLength([line("a")], [])).toBe(0);
  });
});

describe("dropReattachOverlap", () => {
  it("cancels the part of a re-attach's backfill the buffer already holds", () => {
    const lines = [line("1"), line("2"), line("3"), line("2"), line("3"), line("4")];
    expect(dropReattachOverlap(lines, 3).map((l) => l.message)).toEqual([
      "1",
      "2",
      "3",
      "4",
    ]);
  });

  it("keeps the history the backfill exists to recover", () => {
    /*
     * The reconnect this feature is for: the socket dropped after line 7 and the backfill
     * runs 6→12. Cancelling the whole backfill would leave the hole at 8→10 that the
     * backfill was fetched to close, which is the failure mode use-deployment-stream.ts's
     * docblock relies on this not having.
     */
    const prior = ["1", "2", "3", "4", "5", "6", "7"].map((m) => line(m));
    const backfill = ["6", "7", "8", "9", "10", "11", "12"].map((m) => line(m));
    const merged = dropReattachOverlap([...prior, ...backfill], backfill.length);
    expect(merged.map((l) => l.message)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
      "11",
      "12",
    ]);
  });

  it("leaves a genuine repeat alone", () => {
    // Three dots the container printed, then a backfill that also holds three. Four lines
    // survive, not one: the fourth dot is the same content and different output.
    const lines = [dot(), dot(), dot(), dot(), dot(), dot(), line("x")];
    expect(dropReattachOverlap(lines, 4)).toHaveLength(4);
  });

  it("returns the very same array when nothing cancels", () => {
    // Identity, not equality: a phase re-dial whose backfill shares nothing must not hand
    // the client a fresh array to re-render.
    const lines = [line("a"), line("b"), line("c")];
    expect(dropReattachOverlap(lines, 1)).toBe(lines);
  });

  it("ignores a count that cannot describe the buffer", () => {
    const lines = [line("a"), line("b")];
    expect(dropReattachOverlap(lines, 0)).toBe(lines);
    expect(dropReattachOverlap(lines, -1)).toBe(lines);
    // The whole buffer is backfill, so there is no prior half for it to overlap with.
    expect(dropReattachOverlap(lines, 2)).toBe(lines);
    expect(dropReattachOverlap(lines, 99)).toBe(lines);
  });
});

describe("expectReplay", () => {
  it("suppresses a subscription replaying what the backfill just showed", () => {
    const replayed = expectReplay([line("a"), line("b"), line("c")]);
    expect([line("a"), line("b"), line("c"), line("d")].map(replayed)).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it("anchors partway in when the replay is a suffix of the backfill", () => {
    const replayed = expectReplay(["a", "b", "c", "d"].map((m) => line(m)));
    expect(["c", "d", "e"].map((m) => line(m)).map(replayed)).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("shows history the backfill never reached, then suppresses the overlap", () => {
    /*
     * The shape a naive guard gets wrong. The replay's head is older than anything held,
     * so those lines are new to the reader and must be shown — and showing them must not
     * disarm the guard, because the overlap is still ahead of it.
     */
    const replayed = expectReplay(
      ["c", "d"].map((m) => line(m)),
      4,
    );
    expect(["a", "b", "c", "d", "e"].map((m) => line(m)).map(replayed)).toEqual([
      false,
      false,
      true,
      true,
      false,
    ]);
  });

  it("cancels a repeated run exactly once over, and keeps what comes after", () => {
    /*
     * The case that decided the design. Committing to one occurrence of a repeated line
     * gets this wrong in both directions: the last leaves the cursor at the end of the
     * history so every remaining replayed dot leaks as a duplicate, the first leaves it
     * too early so the next line diverges. Tracking every alignment cancels exactly the
     * three that were replayed, and the fourth — which the container really printed — is
     * shown.
     */
    const replayed = expectReplay([dot(), dot(), dot()]);
    expect([dot(), dot(), dot(), dot()].map(replayed)).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it("disarms for good once the replay diverges", () => {
    const replayed = expectReplay(["a", "b", "c"].map((m) => line(m)));
    expect(replayed(line("a"))).toBe(true);
    // Not the replay after all — and nothing re-arms it, including a line that would
    // have matched where it left off.
    expect(replayed(line("z"))).toBe(false);
    expect(replayed(line("b"))).toBe(false);
    expect(replayed(line("c"))).toBe(false);
  });

  it("stops looking after its budget of unrelated lines", () => {
    const replayed = expectReplay(
      ["a", "b"].map((m) => line(m)),
      2,
    );
    expect(["y", "z"].map((m) => line(m)).map(replayed)).toEqual([false, false]);
    // A line that matches the backfill now is a container repeating itself, not a replay.
    expect(replayed(line("a"))).toBe(false);
  });

  it("gives up after a single unrelated line by default", () => {
    // The default budget encodes "a replay that happens at all happens immediately".
    const replayed = expectReplay(["a"].map((m) => line(m)));
    expect(replayed(line("live"))).toBe(false);
    expect(replayed(line("a"))).toBe(false);
  });

  it("suppresses nothing when the backfill was empty", () => {
    // The failed-backfill path: the monitor emits `ready` with zero lines and the guard
    // must not be able to eat the first thing the subscription says.
    const replayed = expectReplay([]);
    expect(replayed(line("a"))).toBe(false);
  });
});
