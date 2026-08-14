import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routerMock, setSearchParams } from "@/test/setup-dom";
import { LIST } from "@/lib/constants";
import { useContainerFilters } from "./use-container-filters";

const settle = () => act(() => void vi.advanceTimersByTime(LIST.SEARCH_DEBOUNCE_MS));

/**
 * Stands in for the browser's address bar.
 *
 * Next patches history.replaceState to feed the router, and the mocked useSearchParams
 * cannot see that — so the spy re-seeds the params mock itself, which is what makes a
 * committed filter observable on the next render.
 */
function spyOnHistory() {
  return vi
    .spyOn(window.history, "replaceState")
    .mockImplementation((_state, _unused, url) => {
      setSearchParams(String(url).split("?")[1] ?? "");
    });
}

beforeEach(() => {
  vi.useFakeTimers();
  setSearchParams("project=p1&environment=e1");
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  routerMock.replace.mockClear();
});

describe("useContainerFilters", () => {
  it("parses the URL on the first render", () => {
    setSearchParams("q=redis&status=failed,running&owner=created");
    const { result } = renderHook(() => useContainerFilters());

    expect(result.current.filters).toEqual({
      query: "redis",
      statuses: ["running", "failed"],
      owners: ["created"],
      sort: "default",
    });
    expect(result.current.draft).toBe("redis");
  });

  it("writes nothing when the URL already says what the filters say", () => {
    const replaceState = spyOnHistory();
    renderHook(() => useContainerFilters());
    settle();
    // The loop breaker. Without it, mounting would write, and writing would re-render.
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("commits a typed query only once it settles", () => {
    const replaceState = spyOnHistory();
    const { result } = renderHook(() => useContainerFilters());

    act(() => result.current.setDraft("red"));
    act(() => void vi.advanceTimersByTime(LIST.SEARCH_DEBOUNCE_MS - 1));
    expect(replaceState).not.toHaveBeenCalled();

    act(() => void vi.advanceTimersByTime(1));
    expect(replaceState).toHaveBeenCalledWith(
      // `null`, never window.history.state: that object carries __NA, which makes Next's
      // patched replaceState take its internal-call early return and skip the router
      // update — the address bar moves and useSearchParams goes stale.
      null,
      "",
      "/dashboard?project=p1&environment=e1&q=red",
    );
  });

  it("keeps the page's own params through a filter write", () => {
    const replaceState = spyOnHistory();
    const { result } = renderHook(() => useContainerFilters());

    act(() => result.current.setStatuses(["running", "failed"]));
    expect(replaceState).toHaveBeenCalledWith(
      null,
      "",
      "/dashboard?project=p1&environment=e1&status=running,failed",
    );
  });

  it("commits chips immediately, with no debounce", () => {
    const replaceState = spyOnHistory();
    const { result } = renderHook(() => useContainerFilters());

    act(() => result.current.setOwners(["external"]));
    expect(replaceState).toHaveBeenCalledTimes(1);
  });

  it("flushes a pending query on demand", () => {
    const replaceState = spyOnHistory();
    const { result } = renderHook(() => useContainerFilters());

    act(() => result.current.setDraft("redis"));
    act(() => result.current.flushDraft());
    expect(replaceState).toHaveBeenCalledWith(
      null,
      "",
      "/dashboard?project=p1&environment=e1&q=redis",
    );

    // The debounce that follows finds nothing left to say.
    replaceState.mockClear();
    settle();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("clears every group and keeps the selection", () => {
    setSearchParams("project=p1&environment=e1&q=redis&status=failed&owner=created");
    const replaceState = spyOnHistory();
    const { result } = renderHook(() => useContainerFilters());

    act(() => result.current.clear());
    expect(replaceState).toHaveBeenCalledWith(
      null,
      "",
      "/dashboard?project=p1&environment=e1",
    );
    expect(result.current.draft).toBe("");
  });

  it("commits a sort the same way a chip commits, with no debounce", () => {
    const replaceState = spyOnHistory();
    const { result } = renderHook(() => useContainerFilters());

    act(() => result.current.setSort("newest"));
    expect(replaceState).toHaveBeenCalledWith(
      null,
      "",
      "/dashboard?project=p1&environment=e1&sort=newest",
    );
  });

  it("leaves the reading order alone when the filters are cleared", () => {
    /*
     * "Clear filters" clears filters. The sort hides nothing, has its own way back through
     * the control's own default, and resetting it here would be the button doing something
     * its label does not mention — the write side of the line `hasActiveFilters` draws.
     */
    setSearchParams("project=p1&environment=e1&q=redis&status=failed&sort=oldest");
    const replaceState = spyOnHistory();
    const { result } = renderHook(() => useContainerFilters());

    act(() => result.current.clear());
    expect(replaceState).toHaveBeenCalledWith(
      null,
      "",
      "/dashboard?project=p1&environment=e1&sort=oldest",
    );
  });

  it("does not claw back text typed while the previous keystroke was settling", () => {
    /*
     * The race the lastCommitted guard exists for: our own URL write must not re-seed the
     * input, or settling on "r" while the user reaches "red" snaps the box back to "r".
     */
    spyOnHistory();
    const { result } = renderHook(() => useContainerFilters());

    act(() => result.current.setDraft("r"));
    settle();
    act(() => result.current.setDraft("red"));

    expect(result.current.draft).toBe("red");
  });

  it("re-seeds the input when the URL moves for someone else's reason", () => {
    const { result, rerender } = renderHook(() => useContainerFilters());

    act(() => setSearchParams("project=p1&environment=e1&q=cache"));
    rerender();

    expect(result.current.draft).toBe("cache");
  });

  it("falls back to the router when the history API is unavailable", () => {
    const original = window.history.replaceState;
    // @ts-expect-error removing the capability the hook probes for
    window.history.replaceState = undefined;
    try {
      const { result } = renderHook(() => useContainerFilters());
      act(() => result.current.setStatuses(["running"]));
      expect(routerMock.replace).toHaveBeenCalledWith(
        "/dashboard?project=p1&environment=e1&status=running",
        // A filter change must not jump the page back to the top.
        { scroll: false },
      );
    } finally {
      window.history.replaceState = original;
    }
  });
});
