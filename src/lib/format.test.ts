import { afterEach, describe, expect, it, vi } from "vitest";
import { formatMemoryGb, formatUptime, formatVcpu, relativeTime } from "./format";

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

describe("formatVcpu", () => {
  it("returns null for an absent value, so the caller owns the placeholder", () => {
    // Null is "Railway said nothing", and the caller renders common.noValue for it. An em
    // dash returned from here would be one more string no catalog could reach.
    expect(formatVcpu(null, "en")).toBeNull();
  });

  it("renders two decimals, including for a genuine zero", () => {
    /*
     * A container that IS running and idle reports 0, and that has to render as 0.00 —
     * distinct from the em dash a container Railway said nothing about gets. The two are
     * different claims and this is the layer where they stop being confusable.
     */
    expect(formatVcpu(0, "en")).toBe("0.00");
    expect(formatVcpu(0.123456, "en")).toBe("0.12");
    expect(formatVcpu(2, "en")).toBe("2.00");
  });

  it("uses the locale's own decimal separator", () => {
    // The reason this goes through Intl at all: "0,12" is not a formatting preference.
    expect(formatVcpu(0.12, "de")).toBe("0,12");
  });
});

describe("formatMemoryGb", () => {
  it("returns null for an absent value", () => {
    expect(formatMemoryGb(null, "en")).toBeNull();
  });

  it("drops to megabytes below a gigabyte, and reports which unit it chose", () => {
    // The unit comes back as a discriminant rather than baked into the string, because the
    // caller has to pick a catalog key with it — a component handed "210 MB" could only
    // concatenate.
    expect(formatMemoryGb(0.21, "en")).toEqual({ value: "210", unit: "mb" });
    expect(formatMemoryGb(0.9999, "en")).toEqual({ value: "1,000", unit: "mb" });
  });

  it("stays in gigabytes at exactly one, and above", () => {
    expect(formatMemoryGb(1, "en")).toEqual({ value: "1.0", unit: "gb" });
    expect(formatMemoryGb(3.14, "en")).toEqual({ value: "3.1", unit: "gb" });
  });

  it("renders a real zero in megabytes rather than as nothing", () => {
    expect(formatMemoryGb(0, "en")).toEqual({ value: "0", unit: "mb" });
  });
});

describe("formatUptime", () => {
  const now = new Date("2026-08-14T12:00:00Z").getTime();
  const ago = (ms: number, locale = "en") =>
    formatUptime(new Date(now - ms).toISOString(), locale, now);

  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  it("returns null for an absent or unparseable timestamp", () => {
    expect(formatUptime(null, "en", now)).toBeNull();
    expect(formatUptime(undefined, "en", now)).toBeNull();
    expect(formatUptime("not a date", "en", now)).toBeNull();
  });

  it("shows two units above an hour, largest first", () => {
    /*
     * The second unit is where the information is: "3d" is the same string for eleven
     * hours of a container's life, so a one-unit readout would sit visibly still while the
     * thing it describes kept running.
     */
    expect(ago(3 * DAY + 4 * HOUR)).toBe("3d 4h");
    expect(ago(4 * HOUR + 12 * MINUTE)).toBe("4h 12m");
  });

  it("shows one unit below an hour", () => {
    expect(ago(12 * MINUTE)).toBe("12m");
    expect(ago(48 * SECOND)).toBe("48s");
  });

  it("renders a just-started deployment as zero seconds, not as nothing", () => {
    expect(ago(0)).toBe("0s");
  });

  it("clamps a future timestamp to zero rather than counting backwards", () => {
    // This is computed against the CLIENT clock while the timestamp came from Railway's, so
    // a few seconds of skew would otherwise render a negative uptime on a healthy row.
    expect(ago(-5 * SECOND)).toBe("0s");
  });

  it("abbreviates in the reader's locale rather than in English letters", () => {
    /*
     * "3d 4h" is not universal — German abbreviates the same duration as "3 T 4 Std." and
     * puts a space in that English does not — which is why this goes through Intl rather
     * than a template string, and why the units need no catalog entry per locale.
     *
     * German rather than a non-Latin locale on purpose: CLDR's narrow forms for Japanese
     * are the English letters, so `ja` would pass this test against a hardcoded suffix too
     * and prove nothing.
     */
    expect(ago(3 * DAY + 4 * HOUR, "de")).toBe("3 T 4 Std.");
  });
});
