import { useRef } from "react";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeContext } from "@/test/fake-canvas-2d";
import { SIM } from "./config";
import { RAIL_YARD_TOKENS, FREIGHT_TOKENS } from "./palette";
import { DEFAULT_DEPS, useRailYard, type RailYardDeps } from "./use-rail-yard";
import type { MediaQueryLike } from "./theme-source";

/**
 * The loop, with every browser edge injected.
 *
 * jsdom's getContext("2d") returns null, so the hook's own null guard is the first thing
 * exercised — and the rest is reachable only because the effect takes its dependencies as
 * a parameter. Every assertion below is about *when* the loop runs, which is the half a
 * browser test would be worst at observing.
 */

const REDUCED = "(prefers-reduced-motion: reduce)";

function fakeQuery(matches: boolean) {
  const listeners = new Set<() => void>();
  const query: MediaQueryLike = {
    get matches() {
      return state.matches;
    },
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  const state = { matches };
  return {
    query,
    set(next: boolean) {
      state.matches = next;
      listeners.forEach((listener) => listener());
    },
    listenerCount: () => listeners.size,
  };
}

function harness({
  reducedMotion = false,
  hidden = false,
  contextIsNull = false,
} = {}) {
  const reduced = fakeQuery(reducedMotion);
  const scheme = fakeQuery(false);
  const painter = createFakeContext();
  const layerContext = createFakeContext();

  const frames: Array<(now: number) => void> = [];
  const raf = vi.fn((callback: (now: number) => void) => {
    frames.push(callback);
    return frames.length;
  });
  const caf = vi.fn();
  const createLayer = vi.fn(() => ({
    ctx: layerContext.ctx,
    image: {} as CanvasImageSource,
  }));

  let themeListener: (() => void) | null = null;
  let sizeListener: (() => void) | null = null;
  let visibilityListener: (() => void) | null = null;
  const stopped = { size: 0, theme: 0, visibility: 0 };
  const state = { hidden };

  // Widened to string[]: the literal union the token lists infer has no indexOf(string).
  const declared: string[] = [...Object.values(RAIL_YARD_TOKENS), ...FREIGHT_TOKENS];
  const readToken = vi.fn((token: string) => {
    const index = declared.indexOf(token);
    return `#${(0x200000 + index * 0x1111).toString(16).slice(0, 6)}`;
  });

  const deps: RailYardDeps = {
    getContext: () => (contextIsNull ? null : painter.ctx),
    createLayer,
    raf,
    caf,
    readToken,
    matches: (query) => (query === REDUCED ? reduced.query : scheme.query),
    observeTheme: (onChange) => {
      themeListener = onChange;
      return () => {
        stopped.theme += 1;
        themeListener = null;
      };
    },
    observeSize: (_target, onChange) => {
      sizeListener = onChange;
      return () => {
        stopped.size += 1;
        sizeListener = null;
      };
    },
    observeVisibility: (onChange) => {
      visibilityListener = onChange;
      return () => {
        stopped.visibility += 1;
        visibilityListener = null;
      };
    },
    isHidden: () => state.hidden,
    measure: () => ({ width: 896, height: 800, dpr: 1 }),
  };

  /**
   * Runs the next `count` scheduled frames, stepping the injected clock by `by` for each.
   *
   * Two of them is one painted frame: `start` schedules a priming callback that does nothing
   * but read the clock, and the tick that draws is the one after it.
   *
   * A count rather than "drain the queue", which is what this was. A raf loop reschedules
   * itself from inside the callback, so the queue never empties and every call ran the
   * five-hundred-frame runaway guard to its end — a test asserting that the static layer is
   * composed twice spent three seconds painting fifteen hundred frames to find out. Nothing
   * here asserts anything about the five hundredth.
   */
  const advance = (by: number, count = 2, from = 0) => {
    let now = from;
    for (let index = 0; index < count; index++) {
      const next = frames.shift();
      if (!next) break;
      now += by;
      next(now);
    }
    return now;
  };

  return {
    deps,
    painter,
    layerContext,
    raf,
    caf,
    createLayer,
    readToken,
    reduced,
    stopped,
    frames,
    advance,
    setHidden: (next: boolean) => {
      state.hidden = next;
      visibilityListener?.();
    },
    fireTheme: () => themeListener?.(),
    fireResize: () => sizeListener?.(),
  };
}

/** A canvas and the hook attached to it, which is all the component under test is. */
function Host({ deps }: { deps: RailYardDeps }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useRailYard(ref, deps);
  return <canvas ref={ref} />;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useRailYard", () => {
  it("does nothing at all when the browser gives no 2D context", () => {
    /*
     * jsdom's own answer, and any browser that refuses. The landing page is complete
     * without the yard, so the loop must not start and nothing may throw — which is why
     * rail-yard.test.tsx can render the real component with no injection at all.
     */
    const kit = harness({ contextIsNull: true });
    expect(() => render(<Host deps={kit.deps} />)).not.toThrow();
    expect(kit.raf).not.toHaveBeenCalled();
    expect(kit.createLayer).not.toHaveBeenCalled();
  });

  it("starts the loop and steps the simulation on a fixed grid", () => {
    const kit = harness();
    render(<Host deps={kit.deps} />);
    expect(kit.raf).toHaveBeenCalled();

    const before = kit.painter.ops.length;
    kit.advance(SIM.STEP_MS);
    expect(kit.painter.ops.length).toBeGreaterThan(before);
  });

  it("never schedules a frame under reduced motion", () => {
    /*
     * The global rule in globals.css clamps animations and transitions, and
     * requestAnimationFrame is neither — it is the one motion on this page that
     * stylesheet cannot reach, so the decision has to be made here.
     */
    const kit = harness({ reducedMotion: true });
    render(<Host deps={kit.deps} />);

    expect(kit.raf).not.toHaveBeenCalled();
    // One frame, painted directly: the yard already at work, held still.
    expect(kit.painter.opsOf("drawImage").length).toBe(1);
  });

  it("repaints the still frame when the box resizes", () => {
    const kit = harness({ reducedMotion: true });
    render(<Host deps={kit.deps} />);
    const before = kit.painter.opsOf("drawImage").length;

    kit.fireResize();
    expect(kit.painter.opsOf("drawImage").length).toBe(before + 1);
    expect(kit.raf).not.toHaveBeenCalled();
  });

  it("starts and stops the loop when the preference changes live", () => {
    const kit = harness({ reducedMotion: true });
    render(<Host deps={kit.deps} />);
    expect(kit.raf).not.toHaveBeenCalled();

    kit.reduced.set(false);
    expect(kit.raf).toHaveBeenCalled();

    kit.reduced.set(true);
    expect(kit.caf).toHaveBeenCalled();
  });

  it("cancels the loop while the tab is hidden and resumes without a burst", () => {
    const kit = harness();
    render(<Host deps={kit.deps} />);
    kit.advance(SIM.STEP_MS);

    kit.setHidden(true);
    expect(kit.caf).toHaveBeenCalled();

    const scheduled = kit.raf.mock.calls.length;
    kit.setHidden(false);
    // Exactly one frame requested on return, not a catch-up storm.
    expect(kit.raf.mock.calls.length).toBe(scheduled + 1);
  });

  it("does not start the loop if the tab is already hidden", () => {
    const kit = harness({ hidden: true });
    render(<Host deps={kit.deps} />);
    expect(kit.raf).not.toHaveBeenCalled();
  });

  it("composes the static layer once, not once per frame", () => {
    const kit = harness();
    render(<Host deps={kit.deps} />);
    kit.advance(SIM.STEP_MS);
    kit.advance(SIM.STEP_MS);
    expect(kit.createLayer).toHaveBeenCalledTimes(1);
  });

  it("recomposes the layer exactly once when the theme changes", () => {
    // Once per invalidation, never once per frame: each rebuild is a full repaint of the
    // sky, the skyline, the ground and every sleeper in the yard.
    const kit = harness();
    render(<Host deps={kit.deps} />);
    kit.advance(SIM.STEP_MS);
    expect(kit.createLayer).toHaveBeenCalledTimes(1);

    kit.fireTheme();
    kit.advance(SIM.STEP_MS);
    kit.advance(SIM.STEP_MS);
    expect(kit.createLayer).toHaveBeenCalledTimes(2);
  });

  it("paints nothing when the token layer does not answer", () => {
    const kit = harness();
    const deps: RailYardDeps = { ...kit.deps, readToken: () => "" };
    render(<Host deps={deps} />);
    kit.advance(SIM.STEP_MS);
    // Transparent canvas over --rc-canvas: the landing page as it was before the yard.
    expect(kit.painter.opsOf("drawImage")).toHaveLength(0);
  });

  it("releases every listener on unmount", () => {
    const kit = harness();
    const view = render(<Host deps={kit.deps} />);
    expect(kit.reduced.listenerCount()).toBe(1);

    view.unmount();
    expect(kit.stopped).toEqual({ size: 1, theme: 1, visibility: 1 });
    expect(kit.reduced.listenerCount()).toBe(0);
    expect(kit.caf).toHaveBeenCalled();
  });
});

/**
 * The browser adapters, exercised against jsdom rather than described.
 *
 * They are thin by design — one line each, wrapping the platform — and thin is exactly
 * what makes them easy to leave untested and easy to get wrong: an adapter that observes
 * the wrong attribute, or returns a disconnect that disconnects nothing, fails silently
 * in production and in every test that injects its own fakes instead.
 */
describe("DEFAULT_DEPS", () => {
  it("asks the canvas for a 2D context and passes the answer through", () => {
    // jsdom's answer is null, which is the branch the hook is built around.
    const canvas = document.createElement("canvas");
    expect(DEFAULT_DEPS.getContext(canvas)).toBeNull();
  });

  it("returns no layer when the offscreen canvas has no context either", () => {
    expect(DEFAULT_DEPS.createLayer(100, 50, 2)).toBeNull();
  });

  it("schedules and cancels a frame", async () => {
    const seen = await new Promise<boolean>((done) => {
      const handle = DEFAULT_DEPS.raf(() => done(true));
      expect(typeof handle).toBe("number");
      setTimeout(() => done(false), 100);
    });
    expect(seen).toBe(true);

    // Cancelling an unknown handle must not throw; the cleanup path calls it blind.
    expect(() => DEFAULT_DEPS.caf(9_999)).not.toThrow();
  });

  it("reads a custom property off the document element", () => {
    document.documentElement.style.setProperty("--rc-yard-ground", "#abcdef");
    expect(DEFAULT_DEPS.readToken("--rc-yard-ground").trim()).toBe("#abcdef");
    document.documentElement.style.removeProperty("--rc-yard-ground");
  });

  it("hands back a real media query list", () => {
    const query = DEFAULT_DEPS.matches(REDUCED);
    expect(typeof query.matches).toBe("boolean");
    expect(() => {
      const listener = () => {};
      query.addEventListener("change", listener);
      query.removeEventListener("change", listener);
    }).not.toThrow();
  });

  it("watches the theme attribute, and stops when told to", async () => {
    // The toggle writes data-theme on <html>; no media query reports that, which is why
    // this observer exists alongside the colour-scheme one.
    const changes = vi.fn();
    const stop = DEFAULT_DEPS.observeTheme(changes);

    document.documentElement.setAttribute("data-theme", "light");
    await Promise.resolve();
    expect(changes).toHaveBeenCalled();

    stop();
    changes.mockClear();
    document.documentElement.setAttribute("data-theme", "dark");
    await Promise.resolve();
    expect(changes).not.toHaveBeenCalled();

    document.documentElement.removeAttribute("data-theme");
  });

  it("observes an element's box and returns a working disconnect", () => {
    const stop = DEFAULT_DEPS.observeSize(document.createElement("div"), () => {});
    expect(() => stop()).not.toThrow();
  });

  it("watches visibility, and stops when told to", () => {
    const changes = vi.fn();
    const stop = DEFAULT_DEPS.observeVisibility(changes);

    document.dispatchEvent(new Event("visibilitychange"));
    expect(changes).toHaveBeenCalledTimes(1);

    stop();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it("reports whether the tab is hidden", () => {
    expect(DEFAULT_DEPS.isHidden()).toBe(false);
  });

  it("measures an element in CSS pixels plus the device ratio", () => {
    const measured = DEFAULT_DEPS.measure(document.createElement("div"));
    expect(measured).toEqual({ width: 0, height: 0, dpr: expect.any(Number) });
    expect(measured.dpr).toBeGreaterThan(0);
  });
});
