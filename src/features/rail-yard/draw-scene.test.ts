import { describe, expect, it } from "vitest";
import { createFakeContext } from "@/test/fake-canvas-2d";
import { KNOWN, PALETTE, graph, numbers, view } from "@/test/rail-yard";
import { TRACK } from "./config";
import { composeStaticLayer } from "./draw-scene";
import { RAIL_YARD_SCENE } from "./scene";

/*
 * Carved out of `render.test.ts`, which covered three source files at once and left
 * `draw-scene.ts` — the whole static layer — with no colocated test of its own.
 */

describe("composeStaticLayer", () => {
  const recorder = createFakeContext();
  composeStaticLayer(recorder.ctx, RAIL_YARD_SCENE, graph, view, PALETTE);

  it("clears before it paints", () => {
    expect(recorder.indexOf("clearRect")).toBe(0);
  });

  it("balances save and restore", () => {
    const depth = recorder.ops.reduce(
      (level, entry) =>
        level + (entry.op === "save" ? 1 : entry.op === "restore" ? -1 : 0),
      0,
    );
    expect(depth).toBe(0);
    expect(recorder.ctx.globalAlpha).toBe(1);
  });

  it("only ever paints in colours the palette declares", () => {
    /*
     * The assertion that makes a stray hex literal in a .ts file a failing test, which is
     * otherwise unenforceable — eslint's hex ban covers .tsx markup, not a string handed to
     * fillStyle.
     */
    const stray = recorder.styles.filter((style) => !KNOWN.has(style));
    expect(stray).toEqual([]);
  });

  it("hands the context no non-finite number", () => {
    // A NaN from a degenerate view silently draws nothing in a real browser.
    expect(numbers(recorder).every(Number.isFinite)).toBe(true);
  });

  it("paints the sky as a gradient, behind everything else", () => {
    expect(recorder.indexOf("createLinearGradient")).toBeLessThan(
      recorder.indexOf("fill"),
    );
    const stops = recorder.opsOf("addColorStop");
    expect(stops.map((entry) => entry.args[1])).toEqual([
      PALETTE.skyHigh,
      PALETTE.skyLow,
    ]);
  });

  it("lays the rails over the ballast, and both over the ground", () => {
    const ground = recorder.styles.indexOf(PALETTE.ground);
    const ballast = recorder.styles.indexOf(PALETTE.ballast);
    const rail = recorder.styles.indexOf(PALETTE.rail);
    expect(ground).toBeGreaterThanOrEqual(0);
    expect(ballast).toBeGreaterThan(ground);
    expect(rail).toBeGreaterThan(ballast);
  });

  it("sleepers a straight road as thoroughly as a curved one", () => {
    /*
     * The direct regression test for "horizontal tracks are different from curved".
     *
     * The previous version placed a tie by rounding into the sample table — and a straight
     * has exactly two samples, so every sleeper on it landed on one of the two endpoints.
     * The whole main line was drawn as bare ballast with a dark blob at each end. Ties are
     * placed by arc length now, so a road gets one every `tieSpacing` for its whole length.
     */
    const road = RAIL_YARD_SCENE.roads.find(
      (candidate) => candidate.id === "express-west",
    )!;
    const span = road.span[1] - road.span[0];

    const ties = recorder.ops.filter(
      (entry) => entry.op === "set:strokeStyle" && entry.args[0] === PALETTE.tie,
    ).length;
    expect(ties).toBeGreaterThan(0);

    // Distinct sleeper positions on the nearest road, which is a plain straight.
    const xs = new Set<number>();
    let painting = false;
    for (const entry of recorder.ops) {
      if (entry.op === "set:strokeStyle") painting = entry.args[0] === PALETTE.tie;
      if (painting && entry.op === "moveTo")
        xs.add(Math.round(entry.args[0] as number));
    }
    expect(xs.size).toBeGreaterThan(span / TRACK.tieSpacing / 4);
  });
});
