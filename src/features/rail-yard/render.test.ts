import { describe, expect, it } from "vitest";
import { createFakeContext, type FakeContext } from "@/test/fake-canvas-2d";
import { CONTAINER, LOCOMOTIVE, VIEW } from "./config";
import { composeStaticLayer } from "./draw-scene";
import { resolvePalette, type YardPalette } from "./palette";
import { drawFrame, type Layer } from "./render";
import { createRng } from "./rng";
import { RAIL_YARD_SCENE } from "./scene";
import { createWorld, step, type WorldState } from "./simulation";
import { fitView, type ViewTransform } from "./view";

/**
 * The renderer, against a recording context rather than a real canvas.
 *
 * jsdom implements no 2D context, so a pixel test is not on offer — and it would be the
 * wrong test anyway. What matters here are properties a screenshot cannot state: that the
 * save/restore stack balances, that every colour ever assigned came from the palette, and
 * that nothing non-finite reaches a draw call. A NaN coordinate draws nothing at all in a
 * real browser, silently, which is the hardest kind of blank canvas to diagnose.
 */

/** A distinct colour per token, so a stray literal in the renderer stands out. */
const PALETTE_VALUES = new Map<string, string>();
const palette: YardPalette = (() => {
  let index = 0;
  const resolved = resolvePalette((token) => {
    const value = `#${(0x100000 + index++ * 0x1111).toString(16).slice(0, 6)}`;
    PALETTE_VALUES.set(token, value);
    return value;
  });
  if (!resolved) throw new Error("the test palette did not resolve");
  return resolved;
})();

const KNOWN_COLOURS = new Set<string>(PALETTE_VALUES.values());

const VIEWPORT = { width: 896, height: 800, dpr: 1 };
const view: ViewTransform = fitView(RAIL_YARD_SCENE, VIEWPORT)!;

function worldWithLoadedTrain(): WorldState {
  const rng = createRng(1234);
  const world = createWorld(rng);
  // Run on until at least one train is drawing a rake, which is what exercises the
  // container and shadow paths.
  for (let elapsed = 0; elapsed < 300_000; elapsed += 20) {
    step(world, 20, rng);
    if (world.trains.some((train) => train.wagons.length > 0 && train.path !== null))
      break;
  }
  return world;
}

function fakeLayer(): { layer: Layer; recorder: FakeContext } {
  const recorder = createFakeContext();
  return {
    recorder,
    layer: { ctx: recorder.ctx, image: {} as CanvasImageSource },
  };
}

/** Every numeric argument the context was ever handed. */
const numbers = (recorder: FakeContext): number[] =>
  recorder.ops.flatMap((entry) =>
    entry.args.filter((arg): arg is number => typeof arg === "number"),
  );

describe("composeStaticLayer", () => {
  const { recorder } = (() => {
    const context = createFakeContext();
    composeStaticLayer(
      context.ctx,
      RAIL_YARD_SCENE,
      createWorld(createRng(1)).graph,
      view,
      palette,
    );
    return { recorder: context };
  })();

  it("clears before it paints", () => {
    expect(recorder.indexOf("clearRect")).toBe(0);
  });

  it("balances save and restore", () => {
    let depth = 0;
    let lowest = 0;
    for (const entry of recorder.ops) {
      if (entry.op === "save") depth += 1;
      if (entry.op === "restore") depth -= 1;
      lowest = Math.min(lowest, depth);
    }
    expect(depth).toBe(0);
    expect(lowest, "restored more than it saved").toBe(0);
  });

  it("only ever paints in colours the palette declares", () => {
    /*
     * The assertion that makes a stray "#333" in a .ts file a failing test. The eslint
     * appearance bans only see className attributes, so nothing else in this repo can
     * catch a hex literal in a renderer.
     */
    for (const colour of recorder.styles) {
      expect(KNOWN_COLOURS.has(colour), `${colour} is not a palette colour`).toBe(true);
    }
  });

  it("hands the context no non-finite number", () => {
    // A NaN coordinate draws nothing in a real browser, with no error anywhere.
    expect(numbers(recorder).filter((value) => !Number.isFinite(value))).toEqual([]);
  });

  it("paints the sky as a gradient, behind everything else", () => {
    expect(recorder.opsOf("addColorStop")).toHaveLength(2);
    expect(recorder.indexOf("createLinearGradient")).toBeLessThan(
      recorder.indexOf("stroke"),
    );
  });

  it("lays the rails over the ballast, and both over the ground", () => {
    const groundFill = recorder.indexOf("fillRect");
    const firstStroke = recorder.indexOf("stroke");
    expect(groundFill).toBeGreaterThan(-1);
    expect(firstStroke).toBeGreaterThan(groundFill);
  });

  it("draws a tie for every sleeper spacing along the yard", () => {
    // Enough to read as sleepers rather than as a decorative few.
    expect(recorder.opsOf("stroke").length).toBeGreaterThan(100);
  });
});

describe("drawFrame", () => {
  const world = worldWithLoadedTrain();

  const render = (options?: { layer?: boolean; alpha?: number }) => {
    const recorder = createFakeContext();
    const { layer } = fakeLayer();
    drawFrame(
      recorder.ctx,
      options?.layer === false ? null : layer,
      world,
      view,
      palette,
      options?.alpha ?? 0,
    );
    return recorder;
  };

  it("clears and blits the static layer before anything moves", () => {
    const recorder = render();
    expect(recorder.indexOf("clearRect")).toBe(0);
    expect(recorder.indexOf("drawImage")).toBe(1);
  });

  it("draws without a layer at all", () => {
    // createLayer can legitimately return null; the moving half must still paint.
    const recorder = render({ layer: false });
    expect(recorder.opsOf("drawImage")).toHaveLength(0);
    expect(recorder.ops.length).toBeGreaterThan(10);
  });

  it("balances save and restore", () => {
    let depth = 0;
    for (const entry of render().ops) {
      if (entry.op === "save") depth += 1;
      if (entry.op === "restore") depth -= 1;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });

  it("only ever paints in colours the palette declares", () => {
    for (const colour of render().styles) {
      expect(KNOWN_COLOURS.has(colour), `${colour} is not a palette colour`).toBe(true);
    }
  });

  it("hands the context no non-finite number", () => {
    expect(numbers(render()).filter((value) => !Number.isFinite(value))).toEqual([]);
  });

  it("restores the alpha it borrows", () => {
    /*
     * Smoke, wheel hubs and container ribs all dim the context. Leaving it dimmed would
     * fade the next frame's locomotive by whatever the last puff asked for — and the
     * fake stacks save/restore precisely so the difference between a balanced borrow and
     * a leak is visible here rather than in a browser.
     */
    const recorder = render();
    expect(recorder.opsOf("set:globalAlpha").length).toBeGreaterThan(0);
    expect(recorder.ctx.globalAlpha).toBe(1);
  });

  it("draws one container body per loaded wagon, with its corrugation", () => {
    const loaded = world.trains
      .filter((train) => train.path !== null)
      .flatMap((train) => train.wagons)
      .filter((wagon) => wagon.cargo !== null);
    expect(loaded.length).toBeGreaterThan(0);

    const recorder = render();
    const boxes = recorder.opsOf("roundRect").filter((entry) => {
      const [x, y, width, height] = entry.args as number[];
      return (
        x === CONTAINER.rect[0] &&
        y === CONTAINER.rect[1] &&
        width === CONTAINER.rect[2] &&
        height === CONTAINER.rect[3]
      );
    });
    expect(boxes).toHaveLength(loaded.length);

    const ribs = loaded.reduce((total, wagon) => total + wagon.ribs, 0);
    // Every rib is one moveTo/lineTo/stroke triple, plus the box's door panel fill.
    expect(recorder.opsOf("stroke").length).toBeGreaterThanOrEqual(ribs);
  });

  it("gives each vehicle a contact shadow rather than a blur", () => {
    const recorder = render();
    expect(recorder.opsOf("ellipse").length).toBeGreaterThan(0);
    // shadowBlur is the most expensive operation the 2D context has, and a flat ellipse
    // sells the same cue for nothing.
    expect(recorder.ops.some((entry) => entry.op.includes("shadow"))).toBe(false);
  });

  it("advances the drawn position between simulated steps", () => {
    /*
     * The interpolation alpha. Without it a 120 Hz display shows each simulated step
     * twice and the motion reads as a judder rather than as speed.
     */
    const moving = world.trains.find((train) => train.speed > 1 && train.path !== null);
    expect(moving, "no train was moving to interpolate").toBeDefined();

    const at = (alpha: number) =>
      render({ alpha })
        .opsOf("translate")
        .map((entry) => entry.args[0] as number);

    expect(at(0)).not.toEqual(at(0.9));
  });

  it("keeps the locomotive legible at the smallest scale it will ever be drawn", () => {
    const floor = fitView(RAIL_YARD_SCENE, { width: 320, height: 620, dpr: 1 })!;
    expect(floor.scale).toBe(VIEW.MIN_SCALE);

    const body = LOCOMOTIVE.parts.find((part) => part.fill === "loco")!;
    // Asserted as a number rather than promised in a comment: this is the floor
    // MIN_SCALE was chosen against.
    expect(body.rect[3] * floor.scale).toBeGreaterThanOrEqual(VIEW.MIN_FEATURE_PX * 4);
  });

  it("stops drawing detail that is smaller than a pixel", () => {
    const tiny: ViewTransform = { ...view, scale: 0.02 };
    const recorder = createFakeContext();
    const { layer } = fakeLayer();
    drawFrame(recorder.ctx, layer, world, tiny, palette, 0);

    // The ribs and hubs drop out; the bodies do not. Fewer ops than at full size.
    const full = render();
    expect(recorder.ops.length).toBeLessThan(full.ops.length);
  });
});
