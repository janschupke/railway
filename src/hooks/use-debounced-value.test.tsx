import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDebouncedValue } from "./use-debounced-value";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useDebouncedValue", () => {
  it("returns the initial value without waiting", () => {
    // A deep-linked filter must apply on the first paint, not a quarter-second later.
    const { result } = renderHook(() => useDebouncedValue("redis", 250));
    expect(result.current).toBe("redis");
  });

  it("holds the previous value until the delay elapses", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 250),
      { initialProps: { value: "" } },
    );

    rerender({ value: "re" });
    act(() => void vi.advanceTimersByTime(249));
    expect(result.current).toBe("");

    act(() => void vi.advanceTimersByTime(1));
    expect(result.current).toBe("re");
  });

  it("cancels a pending settle when the value changes again", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 250),
      { initialProps: { value: "" } },
    );

    rerender({ value: "r" });
    act(() => void vi.advanceTimersByTime(200));
    rerender({ value: "red" });
    act(() => void vi.advanceTimersByTime(200));
    // "r" never surfaces: its timer was cleared before it could fire.
    expect(result.current).toBe("");

    act(() => void vi.advanceTimersByTime(50));
    expect(result.current).toBe("red");
  });

  it("clears its timer on unmount", () => {
    const { rerender, unmount } = renderHook(
      ({ value }) => useDebouncedValue(value, 250),
      { initialProps: { value: "" } },
    );
    rerender({ value: "redis" });
    unmount();
    // A set-state after unmount would warn here, and console.spec treats that as a failure.
    expect(() => act(() => void vi.advanceTimersByTime(250))).not.toThrow();
  });
});
