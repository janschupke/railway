import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cn, relativeTime, sleep } from "./utils";

describe("cn", () => {
  it("joins conditional classes", () => {
    expect(cn("a", false && "b", "c")).toBe("a c");
  });

  it("lets a later Tailwind utility win over an earlier conflicting one", () => {
    // The reason twMerge is here at all: a caller's className must beat the default.
    expect(cn("px-2 text-sm", "px-4")).toBe("text-sm px-4");
  });

  it("keeps a type-scale size alongside a text colour", () => {
    /*
     * The scale's sizes are not Tailwind's own, so an unconfigured tailwind-merge reads
     * `text-caption` as a colour and drops it as conflicting with the colour beside it.
     * The class disappears from the output and the element silently renders at whatever
     * it inherited — invisible in review, and invisible to any test that only asserts
     * the class was passed in.
     */
    expect(cn("text-caption", "text-text-muted")).toBe("text-caption text-text-muted");
    expect(cn("text-mono text-text-subtle")).toBe("text-mono text-text-subtle");
  });

  it("still treats two type-scale sizes as conflicting", () => {
    // A caller overriding the size must win, exactly as with Tailwind's own steps.
    expect(cn("text-body", "text-caption")).toBe("text-caption");
    expect(cn("text-sm", "text-display")).toBe("text-display");
  });
});

describe("relativeTime", () => {
  afterEach(() => vi.useRealTimers());

  const at = (iso: string, now: string, locale = "en") => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    return relativeTime(iso, locale);
  };

  it("returns null for a missing timestamp, so the caller owns the placeholder", () => {
    // An em dash baked in here would be one more string no catalog could reach.
    expect(relativeTime(null, "en")).toBeNull();
    expect(relativeTime(undefined, "en")).toBeNull();
  });

  it("returns null rather than NaN for an unparseable value", () => {
    expect(relativeTime("not a date", "en")).toBeNull();
  });

  it("scales the unit with the distance", () => {
    expect(at("2026-08-12T10:00:00Z", "2026-08-12T10:00:30Z")).toBe("30 seconds ago");
    expect(at("2026-08-12T10:00:00Z", "2026-08-12T10:05:00Z")).toBe("5 minutes ago");
    expect(at("2026-08-12T10:00:00Z", "2026-08-12T13:00:00Z")).toBe("3 hours ago");
    expect(at("2026-08-10T10:00:00Z", "2026-08-12T10:00:00Z")).toBe("2 days ago");
  });

  it("pluralises, which the hand-rolled version could not", () => {
    expect(at("2026-08-12T10:00:00Z", "2026-08-12T10:00:01Z")).toBe("1 second ago");
    expect(at("2026-08-12T10:00:00Z", "2026-08-12T10:01:00Z")).toBe("1 minute ago");
  });

  it("follows the locale's own wording and word order", () => {
    /*
     * The point of Intl over string templates: "ago" is a suffix in English and a
     * prefix in German, and neither is something a translator should have to fake.
     */
    expect(at("2026-08-12T10:00:00Z", "2026-08-12T13:00:00Z", "de")).toBe(
      "vor 3 Stunden",
    );
  });

  it("clamps a future timestamp to zero instead of counting backwards", () => {
    // Server and client clocks disagree; "in 4 seconds" on a created-at reads as a bug.
    expect(at("2026-08-12T10:00:05Z", "2026-08-12T10:00:00Z")).toBe("now");
  });
});

describe("sleep", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resolves after the delay", async () => {
    let done = false;
    void sleep(1_000).then(() => (done = true));

    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(done).toBe(true);
  });

  it("gives up early when the signal aborts, and clears its timer", async () => {
    // The non-abortable version left a poll loop's last sleep pinning a timer after the
    // client had gone; the handle surviving IS the leak, so it is what is asserted.
    const controller = new AbortController();
    let done = false;
    void sleep(60_000, controller.signal).then(() => (done = true));

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not accumulate listeners on a signal it sleeps on repeatedly", async () => {
    /*
     * `{ once: true }` detaches a listener that has fired, and on the normal path this one
     * never does. A poll loop sleeping on one long-lived signal therefore added a listener
     * per iteration, and Node warns at eleven — a MaxListenersExceededWarning pointing at
     * this file, for a signal that is about to be discarded anyway.
     */
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, "addEventListener");
    const removed = vi.spyOn(controller.signal, "removeEventListener");

    for (let i = 0; i < 20; i++) {
      const slept = sleep(1_000, controller.signal);
      await vi.advanceTimersByTimeAsync(1_000);
      await slept;
    }

    expect(added).toHaveBeenCalledTimes(20);
    expect(removed).toHaveBeenCalledTimes(20);
  });

  it("resolves immediately for a signal that has already aborted", async () => {
    // addEventListener never fires for one of these — the same trap the SSE transport
    // hit — so without the up-front check this would wait out the whole delay.
    let done = false;
    void sleep(60_000, AbortSignal.abort()).then(() => (done = true));

    await vi.advanceTimersByTimeAsync(0);

    expect(done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
