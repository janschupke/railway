import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WATCH } from "@/lib/constants";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const { useThrottledRefresh, __resetRefreshThrottle } =
  await import("./use-throttled-refresh");

/** One component per instance, so the test can hold several at once. */
function Caller({ onReady }: { onReady: (fire: () => void) => void }) {
  onReady(useThrottledRefresh());
  return null;
}

/** Renders `count` independent callers and hands back their fire functions. */
function mountCallers(count: number): Array<() => void> {
  const fires: Array<() => void> = [];
  render(
    <>
      {Array.from({ length: count }, (_, i) => (
        <Caller key={i} onReady={(fire) => fires.push(fire)} />
      ))}
    </>,
  );
  return fires;
}

describe("useThrottledRefresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T00:00:00Z"));
    refresh.mockClear();
    __resetRefreshThrottle();
  });
  afterEach(() => vi.useRealTimers());

  it("refreshes on the first call", () => {
    const [fire] = mountCallers(1);
    act(() => fire!());
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("coalesces calls from separate component instances", () => {
    /*
     * THE defect. Both refresh sources already had a guard, but each kept it in its own
     * closure — so eight rows settling in the same second were eight refreshes of a
     * force-dynamic route, which is sixteen Railway round trips against a rate limit
     * this codebase treats as the binding constraint everywhere else. A per-instance
     * guard cannot coalesce across instances however small the interval is.
     */
    const fires = mountCallers(8);
    act(() => fires.forEach((fire) => fire()));

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("allows the next refresh once the gap has elapsed", () => {
    const [fire] = mountCallers(1);

    act(() => fire!());
    act(() => void vi.advanceTimersByTime(WATCH.MIN_REFRESH_GAP_MS - 1));
    act(() => fire!());
    expect(refresh).toHaveBeenCalledTimes(1);

    act(() => void vi.advanceTimersByTime(2));
    act(() => fire!());
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("drops the suppressed call rather than queueing it", () => {
    // A trailing refresh would pay the two round trips anyway and land after the moment
    // it mattered; the caller's own state is already correct by the time this runs.
    const [fire] = mountCallers(1);

    act(() => fire!());
    act(() => fire!());
    act(() => void vi.advanceTimersByTime(WATCH.MIN_REFRESH_GAP_MS * 5));

    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
