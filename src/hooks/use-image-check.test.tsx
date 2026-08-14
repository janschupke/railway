import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REGISTRY } from "@/lib/constants";
import { DEFAULT_IMAGE } from "@/lib/presets";
import { useImageCheck } from "./use-image-check";

const fetchMock = vi.fn<typeof fetch>();

const respond = (status: string) =>
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ status }), {
      headers: { "content-type": "application/json" },
    }),
  );

/**
 * Past the debounce and through the answer.
 *
 * Two flushes, and both are needed: the first runs the effect the settled value schedules,
 * the second lets the fetch promise resolve and the state land. `waitFor` cannot be used
 * here at all — it polls on real timers, which these tests have replaced, so it waits out
 * its own timeout instead of the hook's.
 */
const settle = async () => {
  await act(async () => {
    vi.advanceTimersByTime(REGISTRY.DEBOUNCE_MS + 1);
  });
  await act(async () => {});
};

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  respond("unavailable");
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useImageCheck", () => {
  it("asks once the value has stopped moving", async () => {
    /*
     * Mounted on a preset, because that is what the form does — `useDebouncedValue` does
     * not delay its first render, so the value a component mounts with is checked
     * immediately, and the only reason that costs nothing here is the preset skip.
     */
    const { result, rerender } = renderHook(({ image }) => useImageCheck(image), {
      initialProps: { image: DEFAULT_IMAGE },
    });

    rerender({ image: "own" });
    rerender({ image: "owner/a" });
    rerender({ image: "owner/app" });
    // Still mid-word: firing here would spend a request per keystroke against a rate
    // limit every user of a deployed instance shares.
    expect(fetchMock).not.toHaveBeenCalled();

    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/image-check?ref=owner%2Fapp",
      expect.anything(),
    );
    expect(result.current).toBe("unavailable");
  });

  it.each(["available", "unknown", "unsupported"])(
    "passes %s through",
    async (status) => {
      respond(status);
      const { result } = renderHook(() => useImageCheck("owner/app"));
      await settle();
      expect(result.current).toBe(status);
    },
  );

  /*
   * The largest saving available, and the reason it is keyed on the exact reference.
   * `presetFor` matches on repository, so a repository match would treat
   * `postgres:99-nonexistent` as a known preset and skip the one case worth checking —
   * and the field's own default value is a preset, so without this every visitor to the
   * dashboard would spend a request confirming what the catalog already guarantees.
   */
  it("never asks about a catalog preset", async () => {
    const { result } = renderHook(() => useImageCheck(DEFAULT_IMAGE));
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  it("asks about a preset repository on a tag the catalog does not carry", async () => {
    const { result } = renderHook(() => useImageCheck("postgres:99-nonexistent"));
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current).toBe("unavailable");
  });

  it.each([
    ["nothing typed yet", ""],
    ["whitespace", "   "],
    ["a reference the form itself will refuse", "redis; rm -rf /"],
    ["one over the length ceiling", `owner/${"a".repeat(300)}`],
  ])("says nothing about %s, without asking", async (_label, image) => {
    const { result } = renderHook(() => useImageCheck(image));
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  it("drops a stale answer when the value changes under it", async () => {
    const { result, rerender } = renderHook(({ image }) => useImageCheck(image), {
      initialProps: { image: "owner/app" },
    });
    await settle();
    expect(result.current).toBe("unavailable");

    // A warning about the previous reference sitting under the current one is worse than
    // no warning: it names a problem with something the field no longer holds.
    rerender({ image: "owner/other" });
    expect(result.current).toBeNull();
  });

  it("cancels the request the next keystroke makes obsolete", async () => {
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation((_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return new Promise<Response>(() => {});
    });

    const { rerender } = renderHook(({ image }) => useImageCheck(image), {
      initialProps: { image: "owner/app" },
    });
    await settle();

    rerender({ image: "owner/other" });
    await settle();

    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  it("cancels an answer still in flight when the form unmounts", async () => {
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation((_input, init) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });

    const { unmount } = renderHook(() => useImageCheck("owner/app"));
    await settle();
    unmount();

    expect(signal?.aborted).toBe(true);
  });

  describe("says nothing rather than reporting a failure", () => {
    /*
     * There is no client-to-server error channel in this app — a hook may not import
     * lib/logger — and nothing to report anyway: a check that failed and a check that
     * answered `unknown` put the same nothing on screen.
     */
    it("when the route refuses", async () => {
      fetchMock.mockResolvedValue(new Response(null, { status: 429 }));
      const { result } = renderHook(() => useImageCheck("owner/app"));
      await settle();
      expect(result.current).toBeNull();
    });

    it("when the network fails", async () => {
      fetchMock.mockRejectedValue(new Error("offline"));
      const { result } = renderHook(() => useImageCheck("owner/app"));
      await settle();
      expect(result.current).toBeNull();
    });

    it("when the body is not JSON", async () => {
      fetchMock.mockResolvedValue(new Response("<html>"));
      const { result } = renderHook(() => useImageCheck("owner/app"));
      await settle();
      expect(result.current).toBeNull();
    });

    it.each([
      ["a status this version does not know", JSON.stringify({ status: "banana" })],
      ["a body with no status at all", JSON.stringify({ ok: true })],
      ["a status that is not a string", JSON.stringify({ status: 404 })],
    ])("when the answer is %s", async (_label, body) => {
      fetchMock.mockResolvedValue(
        new Response(body, { headers: { "content-type": "application/json" } }),
      );
      const { result } = renderHook(() => useImageCheck("owner/app"));
      await settle();
      expect(result.current).toBeNull();
    });
  });
});
