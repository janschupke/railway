"use client";

import { useEffect, type RefObject } from "react";
import { SIM, YARD } from "./config";
import { drawFrame, type Layer } from "./render";
import { composeStaticLayer } from "./draw-scene";
import { createRng } from "./rng";
import { RAIL_YARD_SCENE } from "./scene";
import { createWorld } from "./create-world";
import { step } from "./simulation";
import { createThemeSource, type MediaQueryLike } from "./theme-source";
import { fitView, type ViewTransform } from "./view";

/**
 * How many fixed steps a frame's delta is worth, and what is left over.
 *
 * Here rather than in `simulation.ts`, where it used to live among the rules: it takes no
 * world and knows nothing about trains. It is bookkeeping for *this* loop — the remainder
 * becomes the renderer's interpolation alpha, so the simulation stays on its fixed grid
 * while a 120 Hz display still gets smooth motion.
 *
 * The clamp is the spiral-of-death guard: a tab that wakes after four seconds must not run
 * two hundred steps on the frame it wakes on, which is a visible freeze followed by every
 * train teleporting. The excess is dropped rather than repaid — nobody was watching.
 */
export function stepsFor(
  accumulator: number,
  deltaMs: number,
): { steps: number; rest: number } {
  const total = accumulator + Math.max(0, Math.min(deltaMs, SIM.MAX_CATCHUP_MS));
  const steps = Math.floor(total / SIM.STEP_MS);
  return { steps, rest: total - steps * SIM.STEP_MS };
}

/**
 * Everything the loop touches that is not a pure function.
 *
 * Injected rather than reached for, because jsdom has no 2D context at all: `getContext`
 * returns null there, so the component test exercises the null path and the behavioural
 * tests pass a recording fake instead. Without this seam the loop would be reachable only
 * from a real browser, which is where regressions are most expensive to find.
 */
export type RailYardDeps = {
  getContext: (canvas: HTMLCanvasElement) => CanvasRenderingContext2D | null;
  createLayer: (width: number, height: number, dpr: number) => Layer | null;
  raf: (callback: (now: number) => void) => number;
  caf: (handle: number) => void;
  readToken: (token: string) => string;
  matches: (query: string) => MediaQueryLike;
  observeTheme: (onChange: () => void) => () => void;
  observeSize: (target: Element, onChange: () => void) => () => void;
  observeVisibility: (onChange: () => void) => () => void;
  isHidden: () => boolean;
  measure: (target: Element) => { width: number; height: number; dpr: number };
};

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/**
 * The browser implementations, as one frozen module-level object.
 *
 * Module-level so the effect's dependency array is honest: an object literal in the
 * component would be a new identity every render and would tear the whole loop down and
 * rebuild it on each one.
 */
export const DEFAULT_DEPS: RailYardDeps = {
  getContext: (canvas) => canvas.getContext("2d"),
  createLayer: (width, height, dpr) => {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, image: canvas };
  },
  raf: (callback) => window.requestAnimationFrame(callback),
  caf: (handle) => window.cancelAnimationFrame(handle),
  readToken: (token) =>
    getComputedStyle(document.documentElement).getPropertyValue(token),
  matches: (query) => window.matchMedia(query),
  observeTheme: (onChange) => {
    // The theme toggle writes this attribute on <html>; nothing else reports that.
    const observer = new MutationObserver(onChange);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  },
  observeSize: (target, onChange) => {
    const observer = new ResizeObserver(onChange);
    observer.observe(target);
    return () => observer.disconnect();
  },
  observeVisibility: (onChange) => {
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  },
  isHidden: () => document.visibilityState === "hidden",
  measure: (target) => {
    const rect = target.getBoundingClientRect();
    return {
      width: rect.width,
      height: rect.height,
      dpr: window.devicePixelRatio || 1,
    };
  },
};

/**
 * Runs the yard behind the sign-in card.
 *
 * The whole thing lives in one effect on purpose: the world, the palette, the view and
 * the cached layer all have exactly the lifetime of the mounted canvas, and splitting
 * them across several effects would mean publishing them through refs so the other
 * effects could reach them.
 */
export function useRailYard(
  ref: RefObject<HTMLCanvasElement | null>,
  deps: RailYardDeps = DEFAULT_DEPS,
): void {
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;

    const ctx = deps.getContext(canvas);
    // jsdom, and any browser that refuses a 2D context. The page is complete without it.
    if (!ctx) return;

    const box = canvas.parentElement ?? canvas;
    const rng = createRng(YARD.SEED);
    const world = createWorld(rng);

    let view: ViewTransform | null = null;
    let layer: Layer | null = null;
    let layoutDirty = true;
    let frame = 0;
    let last = 0;
    let accumulator = 0;

    const theme = createThemeSource(deps, () => {
      // A new palette invalidates every pixel of the static layer, not just its colours.
      layoutDirty = true;
    });

    const paint = (alpha: number) => {
      const palette = theme.palette();
      // No palette means the token layer did not answer. Leave the canvas transparent
      // and let --rc-canvas show through, which is the page as it was before the yard.
      if (!palette) return;

      if (layoutDirty || !view) {
        const size = deps.measure(box);
        view = fitView(RAIL_YARD_SCENE, size);
        if (!view) return;

        canvas.width = Math.max(1, Math.round(view.width * view.dpr));
        canvas.height = Math.max(1, Math.round(view.height * view.dpr));
        // All drawing is in CSS pixels; the DPR lives in the transform and nowhere else.
        ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);

        layer = deps.createLayer(view.width, view.height, view.dpr);
        if (layer) {
          composeStaticLayer(layer.ctx, RAIL_YARD_SCENE, world.graph, view, palette);
        }
        layoutDirty = false;
        theme.takeDirty();
      }

      drawFrame(ctx, layer, world, view, palette, alpha);
    };

    const stop = () => {
      if (!frame) return;
      deps.caf(frame);
      frame = 0;
    };

    const tick = (now: number) => {
      frame = deps.raf(tick);
      // The catch-up clamp lives in stepsFor, where it can be asserted — see its comment.
      const { steps, rest } = stepsFor(accumulator, now - last);
      last = now;
      accumulator = rest;
      for (let index = 0; index < steps; index++) step(world, SIM.STEP_MS, rng);
      paint(accumulator / SIM.STEP_MS);
    };

    const start = () => {
      if (frame || deps.isHidden()) return;
      // Reset the clock, or the first delta is the whole time the tab was hidden.
      last = 0;
      accumulator = 0;
      frame = deps.raf((now) => {
        last = now;
        frame = deps.raf(tick);
      });
    };

    /*
     * Reduced motion is decided here rather than in CSS. The global rule in globals.css
     * clamps animations and transitions, and requestAnimationFrame is neither — it is the
     * one motion on this page that stylesheet cannot reach. So the loop never starts, and
     * the visitor gets a single frame of a yard already at work, which is what the
     * simulation's warm-up exists to make worth looking at.
     */
    const reduced = deps.matches(REDUCED_MOTION);

    const apply = () => {
      if (reduced.matches) {
        stop();
        paint(0);
        return;
      }
      start();
    };

    const onResize = () => {
      layoutDirty = true;
      if (reduced.matches) paint(0);
    };

    const onVisibility = () => {
      if (deps.isHidden()) stop();
      else apply();
    };

    const stopSize = deps.observeSize(box, onResize);
    const stopVisibility = deps.observeVisibility(onVisibility);
    reduced.addEventListener("change", apply);
    apply();

    return () => {
      stop();
      stopSize();
      stopVisibility();
      reduced.removeEventListener("change", apply);
      theme.dispose();
    };
  }, [ref, deps]);
}
