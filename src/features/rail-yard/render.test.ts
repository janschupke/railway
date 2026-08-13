import { describe, expect, it } from "vitest";
import { createFakeContext, type FakeContext } from "@/test/fake-canvas-2d";
import { LOCOMOTIVE, TRACK, VIEW } from "./config";
import { composeStaticLayer } from "./draw-scene";
import { drawBox, visibleFaces, type Face } from "./draw-box";
import { buildGraph } from "./graph";
import { RAIL_YARD_TOKENS, FREIGHT_TOKENS, type YardPalette } from "./palette";
import { createRng } from "./rng";
import { RAIL_YARD_SCENE } from "./scene";
import { createWorld, step, type WorldState } from "./simulation";
import { fitView, toScreenY, type ViewTransform } from "./view";
import { YARD } from "./config";
import { drawFrame } from "./render";

/**
 * A palette of distinguishable placeholders.
 *
 * Not real colours: what the renderer must never do is paint in something the palette did
 * not hand it, and a set of tagged strings makes that a set-membership assertion rather
 * than a pixel comparison.
 */
const PALETTE: YardPalette = {
  ...(Object.fromEntries(
    Object.keys(RAIL_YARD_TOKENS).map((key) => [key, `#${key}`]),
  ) as Record<keyof typeof RAIL_YARD_TOKENS, string>),
  freight: FREIGHT_TOKENS.map((_, index) => `#freight-${index}`),
};

const KNOWN = new Set([...Object.values(PALETTE).flat()]);

const VIEWPORT = { width: 960, height: 700, dpr: 1 };
const view = fitView(RAIL_YARD_SCENE, VIEWPORT)!;
const graph = buildGraph(RAIL_YARD_SCENE);

function yard(steps = 0): WorldState {
  const rng = createRng(YARD.SEED);
  const world = createWorld(rng);
  for (let index = 0; index < steps; index++) step(world, 20, rng);
  return world;
}

const numbers = (recorder: FakeContext) =>
  recorder.ops.flatMap((entry) => entry.args.filter((arg) => typeof arg === "number"));

describe("visibleFaces", () => {
  /*
   * Tested directly rather than through a rendered frame. A face-visibility rule checked
   * only by "the picture came out" is checked by accident, and this is four branches that
   * a viewport sweep would take a dozen frames to reach.
   *
   * Named face sets rather than a count, which is the version that would have caught the
   * defect this replaces: the old test asserted "no more than two and never an opposing
   * pair", and one face plus a roof satisfies that perfectly while looking like a cardboard
   * cut-out. The camera sits to the east and to the south, so an eastbound locomotive shows
   * its nose and its near side — and that is what has to be written down.
   */
  const HEADINGS: ReadonlyArray<readonly [string, number, readonly Face[]]> = [
    ["east", 0, ["front", "right"]],
    ["north-east", Math.PI / 4, ["back", "right"]],
    ["north", Math.PI / 2, ["back", "right"]],
    ["north-west", (3 * Math.PI) / 4, ["back", "left"]],
    ["west", Math.PI, ["back", "left"]],
    ["south-west", -(3 * Math.PI) / 4, ["front", "left"]],
    ["south", -Math.PI / 2, ["front", "left"]],
    ["south-east", -Math.PI / 4, ["front", "right"]],
  ];

  it.each(HEADINGS)(
    "shows the camera the right faces heading %s",
    (_name, angle, expected) => {
      expect([...visibleFaces(angle)].sort()).toEqual([...expected].sort());
    },
  );

  it("shows an end and a side at every heading, so nothing reads as a cut-out", () => {
    // Two faces plus the roof is what makes a box look like a box. One face plus a roof is
    // a cardboard cut-out, which is what the yard was full of.
    for (let angle = -Math.PI; angle <= Math.PI; angle += 0.01) {
      const faces = visibleFaces(angle);
      expect(faces.length, `${angle}`).toBe(2);
      expect(faces.includes("front") && faces.includes("back")).toBe(false);
      expect(faces.includes("left") && faces.includes("right")).toBe(false);
    }
  });

  it("drops a pair that is exactly edge-on rather than drawing a zero-area quad", () => {
    // The one heading at which an end faces exactly along the view ray. A sweep never lands
    // on it — it is a single point — so it takes naming to reach at all.
    expect(visibleFaces(Math.atan(VIEW.SHEAR))).toEqual(["right"]);
  });
});

describe("drawBox", () => {
  it("puts the roof above every wall, whichever way the vehicle is facing", () => {
    /*
     * The direct regression test for "upper tracks are upside down, trains on the bottom".
     *
     * The previous renderer placed a vehicle by rotating the canvas through its heading,
     * which past a quarter turn is a mirror rather than a rotation — so every train on a
     * westbound road came out body-down with its shadow floating above it. Corners are
     * rotated in world space now and projected one at a time, so there is no local frame
     * left to flip. Asserted at both headings, because that is the only way to say it.
     */
    const box = { at: [0, -10, 0], size: [40, 20, 18], fill: "loco" } as const;

    for (const angle of [0, Math.PI, Math.PI / 3, -Math.PI / 2]) {
      const recorder = createFakeContext();
      drawBox(recorder.ctx, view, { x: 700, y: 88, angle }, box, PALETTE, 0, null);

      const polygons: number[][] = [];
      let current: number[] = [];
      for (const entry of recorder.ops) {
        if (entry.op === "beginPath") current = [];
        if (entry.op === "moveTo" || entry.op === "lineTo") {
          current.push(entry.args[1] as number);
        }
        if (entry.op === "fill") polygons.push([...current]);
      }

      // The last polygon is the roof; the ones before it are the walls it stands on.
      const roof = polygons[polygons.length - 1]!;
      const roofTop = Math.min(...roof);
      for (let index = 0; index < polygons.length - 1; index++) {
        const wall = polygons[index]!;
        expect(Math.max(...wall), `heading ${angle} wall below roof`).toBeGreaterThan(
          roofTop,
        );
      }
    }
  });

  it("draws a box shorter than a pixel as its roof alone", () => {
    // A wall under a pixel resolves onto its neighbour and only costs fill rate.
    const recorder = createFakeContext();
    const flat = { at: [0, -10, 0], size: [40, 20, 0.4], fill: "metal" } as const;
    drawBox(recorder.ctx, view, { x: 700, y: 88, angle: 0 }, flat, PALETTE, 0, null);
    // Base plus lit wash on the roof, and nothing for the walls.
    expect(recorder.opsOf("fill")).toHaveLength(2);
  });

  it("falls back to metal when a cargo box is handed no cargo", () => {
    const recorder = createFakeContext();
    const box = { at: [0, -8, 0], size: [30, 16, 14], fill: "cargo" } as const;
    drawBox(recorder.ctx, view, { x: 700, y: 88, angle: 0 }, box, PALETTE, 0, null);
    expect(recorder.styles).toContain(PALETTE.metal);
  });
});

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
      (candidate) => candidate.id === "main-out",
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

describe("drawFrame", () => {
  const layer = { ctx: createFakeContext().ctx, image: {} as CanvasImageSource };

  const frame = (world: WorldState, at: ViewTransform = view, alpha = 0) => {
    const recorder = createFakeContext();
    drawFrame(recorder.ctx, layer, world, at, PALETTE, alpha);
    return recorder;
  };

  it("clears and blits the static layer before anything moves", () => {
    const recorder = frame(yard());
    expect(recorder.indexOf("clearRect")).toBe(0);
    expect(recorder.indexOf("drawImage")).toBe(1);
  });

  it("draws without a layer at all", () => {
    // The offscreen canvas can be refused; the yard still has to paint.
    const recorder = createFakeContext();
    drawFrame(recorder.ctx, null, yard(), view, PALETTE, 0);
    expect(recorder.opsOf("drawImage")).toHaveLength(0);
    expect(recorder.ops.length).toBeGreaterThan(10);
  });

  it("balances save and restore, and gives back the alpha it borrows", () => {
    const recorder = frame(yard(300));
    const depth = recorder.ops.reduce(
      (level, entry) =>
        level + (entry.op === "save" ? 1 : entry.op === "restore" ? -1 : 0),
      0,
    );
    expect(depth).toBe(0);
    // A globalAlpha left at a puff's value fades the next frame's locomotive.
    expect(recorder.ctx.globalAlpha).toBe(1);
  });

  it("only ever paints in colours the palette declares", () => {
    const recorder = frame(yard(600));
    expect(recorder.styles.filter((style) => !KNOWN.has(style))).toEqual([]);
  });

  it("hands the context no non-finite number", () => {
    const recorder = frame(yard(600), view, 0.5);
    expect(numbers(recorder).every(Number.isFinite)).toBe(true);
  });

  it("draws a container in its own livery for every loaded wagon", () => {
    const world = yard(600);
    const loaded = world.trains.flatMap((train) =>
      train.wagons.filter((wagon) => wagon.cargo !== null),
    );
    expect(loaded.length).toBeGreaterThan(0);

    const recorder = frame(world);
    const painted = recorder.styles.filter((style) => style.startsWith("#freight-"));
    expect(painted.length).toBeGreaterThan(0);
  });

  it("gives each vehicle a contact shadow rather than a blur", () => {
    /*
     * shadowBlur is the most expensive operation the 2D context has and would dominate the
     * frame on a phone. An ellipse on the ground sells the same cue.
     */
    const world = yard(600);
    const recorder = frame(world);
    const vehicles = world.trains.reduce(
      (count, train) => count + train.wagons.length + 1,
      0,
    );
    expect(recorder.opsOf("ellipse").length).toBeGreaterThan(0);
    expect(recorder.opsOf("ellipse").length).toBeLessThanOrEqual(vehicles);
    expect(recorder.ops.some((entry) => entry.op.startsWith("set:shadow"))).toBe(false);
  });

  it("advances the drawn position between simulated steps", () => {
    // The interpolation alpha: a 50 Hz simulation has to look smooth on a 120 Hz display.
    // Wound on to a frame where something is actually moving, or the claim is vacuous.
    const world = yard();
    const rng = createRng(YARD.SEED);
    while (!world.trains.some((train) => train.speed > 1)) step(world, 20, rng);

    const at = (alpha: number) =>
      frame(world, view, alpha)
        .opsOf("moveTo")
        .map((entry) => entry.args[0] as number);

    expect(at(0)).not.toEqual(at(0.9));
  });

  it("draws the far roads before the near ones, so a train can go behind a shed", () => {
    /*
     * Depth sorting per *drawable*, not per train — a rake straddling a crossover has half
     * its wagons on one road and half on the next, and they have to sort against other
     * traffic independently of the engine pulling them. This is also what lets a shed's
     * front wall occlude a locomotive standing inside it.
     */
    /*
     * Asserted on the contact shadows, because they are the one thing drawn flat on the
     * ground: their screen y is a pure function of depth with no height mixed into it, so a
     * non-decreasing run of them *is* the sort. Reading it off the bodies instead compares
     * roofs against wheels and says nothing. The tolerance covers a vehicle on a crossover,
     * whose shadow sits a few units off its own sort key.
     */
    const ys = frame(yard(600))
      .opsOf("ellipse")
      .map((entry) => entry.args[1] as number);
    expect(ys.length).toBeGreaterThan(3);

    for (let index = 1; index < ys.length; index++) {
      expect(ys[index]!, `shadow ${index}`).toBeGreaterThanOrEqual(ys[index - 1]! - 6);
    }
  });

  it("keeps the locomotive legible at the smallest scale it will ever be drawn", () => {
    const floor = fitView(RAIL_YARD_SCENE, { width: 412, height: 620, dpr: 2 })!;
    expect(floor.scale).toBe(VIEW.MIN_SCALE);

    // Asserted as a number rather than promised in a comment: this is the claim MIN_SCALE
    // was chosen against.
    const body = LOCOMOTIVE.boxes.find((box) => box.fill === "loco")!;
    const top = toScreenY(floor, 0, body.at[2] + body.size[2]);
    const bottom = toScreenY(floor, 0, body.at[2]);
    expect(bottom - top).toBeGreaterThanOrEqual(VIEW.MIN_FEATURE_PX * 4);
  });

  it("stops drawing detail that is smaller than a pixel", () => {
    const tiny = { ...view, scale: 0.02 };
    const small = frame(yard(600), tiny);
    const normal = frame(yard(600), view);
    expect(small.ops.length).toBeLessThan(normal.ops.length);
  });

  it("shows a signal red when the road it guards is occupied", () => {
    /*
     * The lamp reports the simulation rather than being animated alongside it, so a red
     * aspect is always a train and never a decoration.
     */
    const world = yard();
    const aspects = new Set<string>();
    const rng = createRng(YARD.SEED);
    for (let index = 0; index < 3_000; index++) {
      step(world, 20, rng);
      for (const style of frame(world).styles) {
        if (style === PALETTE.signalStop) aspects.add("stop");
        if (style === PALETTE.signalGo) aspects.add("go");
        if (style === PALETTE.signalCaution) aspects.add("caution");
      }
      if (aspects.size === 3) break;
    }
    expect([...aspects].sort()).toEqual(["caution", "go", "stop"]);
  });
});
