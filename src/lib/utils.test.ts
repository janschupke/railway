import { afterEach, describe, expect, it, vi } from "vitest";
import { cn, relativeTime } from "./utils";

describe("cn", () => {
  it("joins conditional classes", () => {
    expect(cn("a", false && "b", "c")).toBe("a c");
  });

  it("lets a later Tailwind utility win over an earlier conflicting one", () => {
    // The reason twMerge is here at all: a caller's className must beat the default.
    expect(cn("px-2 text-sm", "px-4")).toBe("text-sm px-4");
  });
});

describe("relativeTime", () => {
  afterEach(() => vi.useRealTimers());

  const at = (iso: string, now: string) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    return relativeTime(iso);
  };

  it("renders an em dash for a missing timestamp", () => {
    expect(relativeTime(null)).toBe("—");
    expect(relativeTime(undefined)).toBe("—");
  });

  it("renders an em dash rather than NaN for an unparseable value", () => {
    expect(relativeTime("not a date")).toBe("—");
  });

  it("scales the unit with the distance", () => {
    expect(at("2026-08-12T10:00:00Z", "2026-08-12T10:00:30Z")).toBe("30s ago");
    expect(at("2026-08-12T10:00:00Z", "2026-08-12T10:05:00Z")).toBe("5m ago");
    expect(at("2026-08-12T10:00:00Z", "2026-08-12T13:00:00Z")).toBe("3h ago");
    expect(at("2026-08-10T10:00:00Z", "2026-08-12T10:00:00Z")).toBe("2d ago");
  });

  it("clamps a future timestamp to zero instead of counting backwards", () => {
    // Server and client clocks disagree; "-4s ago" reads as a bug.
    expect(at("2026-08-12T10:00:05Z", "2026-08-12T10:00:00Z")).toBe("0s ago");
  });
});
