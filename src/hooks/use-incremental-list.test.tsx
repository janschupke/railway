import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fireIntersection } from "@/test/setup-dom";
import { LIST } from "@/lib/constants";
import { useIncrementalList } from "./use-incremental-list";

const items = (count: number) => Array.from({ length: count }, (_, i) => i);

describe("useIncrementalList", () => {
  it("renders one page of a long list", () => {
    const { result } = renderHook(() => useIncrementalList(items(45), "key"));
    expect(result.current.visible).toHaveLength(LIST.PAGE_SIZE);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.paged).toBe(true);
  });

  it("reports a short list as neither paged nor incomplete", () => {
    const { result } = renderHook(() => useIncrementalList(items(3), "key"));
    expect(result.current.visible).toHaveLength(3);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.paged).toBe(false);
  });

  it("appends a page at a time and stops at the end", () => {
    const { result } = renderHook(() => useIncrementalList(items(45), "key"));

    act(() => result.current.loadMore());
    expect(result.current.visible).toHaveLength(40);

    act(() => result.current.loadMore());
    expect(result.current.visible).toHaveLength(45);
    expect(result.current.hasMore).toBe(false);
  });

  it("does NOT reset when the items array identity changes under the same key", () => {
    /*
     * The regression this hook exists to prevent. The project watcher and every settling
     * row call router.refresh(), each of which lands a structurally new array; resetting
     * on that would return a reader at row 40 to row 20 every few seconds.
     */
    const { result, rerender } = renderHook(
      ({ data }) => useIncrementalList(data, "key"),
      { initialProps: { data: items(45) } },
    );

    act(() => result.current.loadMore());
    expect(result.current.visible).toHaveLength(40);

    rerender({ data: items(45) });
    expect(result.current.visible).toHaveLength(40);
  });

  it("resets to the first page when the selection changes", () => {
    const { result, rerender } = renderHook(
      ({ key }) => useIncrementalList(items(45), key),
      { initialProps: { key: "a" } },
    );

    act(() => result.current.loadMore());
    expect(result.current.visible).toHaveLength(40);

    rerender({ key: "b" });
    expect(result.current.visible).toHaveLength(LIST.PAGE_SIZE);
  });

  it("loads the next page when the sentinel comes into view", () => {
    const { result } = renderHook(() => useIncrementalList(items(45), "key"));
    const node = document.createElement("div");
    act(() => result.current.sentinelRef(node));

    act(() => fireIntersection());
    expect(result.current.visible).toHaveLength(40);
  });

  it("ignores a sentinel that is merely leaving the viewport", () => {
    const { result } = renderHook(() => useIncrementalList(items(45), "key"));
    act(() => result.current.sentinelRef(document.createElement("div")));

    act(() => fireIntersection(false));
    expect(result.current.visible).toHaveLength(LIST.PAGE_SIZE);
  });

  it("stays pageable in a browser with no IntersectionObserver", () => {
    // The manual control is the whole fallback, and it is rendered regardless — which is
    // why the hook reports no capability flag for the caller to branch on.
    const original = window.IntersectionObserver;
    // @ts-expect-error deliberately removing the capability the hook probes for
    delete window.IntersectionObserver;
    try {
      const { result } = renderHook(() => useIncrementalList(items(45), "key"));
      act(() => result.current.sentinelRef(document.createElement("div")));

      act(() => result.current.loadMore());
      expect(result.current.visible).toHaveLength(40);
    } finally {
      window.IntersectionObserver = original;
    }
  });
});
