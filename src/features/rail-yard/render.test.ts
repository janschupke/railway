import { describe, expect, it } from "vitest";
import { createFakeContext, type FakeContext } from "@/test/fake-canvas-2d";
import {
  CONTAINER,
  CONVEYOR,
  CRANE,
  GANTRY,
  LOCOMOTIVE,
  SHED,
  TRACK,
  VIEW,
  WAGON,
  YARD,
} from "./config";
import { composeStaticLayer } from "./draw-scene";
import { drawBox, visibleFaces, type Face } from "./draw-box";
import { buildGraph } from "./graph";
import type { Pose } from "./geometry";
import { RAIL_YARD_TOKENS, FREIGHT_TOKENS, type YardPalette } from "./palette";
import { createRng } from "./rng";
import { RAIL_YARD_SCENE, type SceneStructure } from "./scene";
import { createWorld, step, type WorldState } from "./simulation";
import {
  fitView,
  toScreenY,
  toWorldX,
  toWorldY,
  viewDepth,
  type ViewTransform,
} from "./view";
import { assemblyDepth, drawFrame, shedFrontBoxes, shedRoofBox } from "./render";

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

const SHED_STRUCTURE = RAIL_YARD_SCENE.structures.find(
  (structure): structure is Extract<SceneStructure, { kind: "shed" }> =>
    structure.kind === "shed",
)!;

const GANTRY_STRUCTURE = RAIL_YARD_SCENE.structures.find(
  (structure): structure is Extract<SceneStructure, { kind: "gantry" }> =>
    structure.kind === "gantry",
)!;

/** The plane a shed's front wall stands in — half its depth in front of its road. */
const shedFrontY = (): number =>
  RAIL_YARD_SCENE.roads.find((road) => road.id === SHED_STRUCTURE.road)!.y -
  SHED_STRUCTURE.depth / 2;

/** A structure's pose: standing still, facing east. Structures do not have headings. */
const at = (x: number, y: number): Pose => ({ x, y, angle: 0 });

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

describe("drawFrame", () => {
  const layer = { ctx: createFakeContext().ctx, image: {} as CanvasImageSource };

  const frame = (world: WorldState, at: ViewTransform = view, alpha = 0) => {
    const recorder = createFakeContext();
    drawFrame(recorder.ctx, layer, world, at, PALETTE, alpha);
    return recorder;
  };

  it("paints a vehicle's parts in the order its spec stacks them", () => {
    /*
     * The regression for "wagons and engines render a grey square". Sorting *inside* a
     * vehicle is wrong: a wagon's frame runs its whole length while the front bogie sits
     * under the east end of it, so the bogie's centre is nearer the camera and it was painted
     * on top of the frame — a grey rectangle over the deck at the leading end.
     *
     * Read off the recording rather than off the code. `drawBox` washes every roof with
     * `faceLit` exactly once, so the fill set immediately before each of those is that box's
     * own colour, in draw order — and a wagon's spec is five `metal` parts under one
     * `structureTrim` deck.
     */
    const fills = frame(yard(600))
      .ops.filter((entry) => entry.op === "set:fillStyle")
      .map((entry) => entry.args[0] as string);

    const painted: string[] = [];
    for (let index = 1; index < fills.length; index++) {
      if (fills[index] === PALETTE.faceLit) painted.push(fills[index - 1]!);
    }

    const wagon = WAGON.boxes.map((box) => PALETTE[box.fill as keyof typeof PALETTE]);
    const found = painted.some((_, start) =>
      wagon.every((colour, offset) => painted[start + offset] === colour),
    );
    expect(found, `wagon spec order not found in ${painted.length} painted boxes`).toBe(
      true,
    );
  });

  it("corrugates the freight on the belt, not only the freight on wagons", () => {
    /*
     * The panels are what make a container read as a container rather than as a coloured
     * brick, and the belt's were never drawn — `conveyorDrawables` passed no corrugation at
     * all, so a box acquired its panels on being set down on a wagon and lost them again on
     * being picked up.
     *
     * Counted by emptying the belt and drawing the same world twice: one rib pass sets the
     * trim colour once, so the drop is exactly the freight that was standing on the belt.
     */
    const world = yard(600);
    const ribbed = (state: WorldState) =>
      frame(state).styles.filter((style) => style === PALETTE.locoTrim).length;

    const withFreight = ribbed(world);
    world.conveyor.boxes = [];
    expect(withFreight).toBeGreaterThan(ribbed(world));
  });

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

  it("draws the far vehicles before the near ones, so a train can go behind a shed", () => {
    /*
     * Asserted on the contact shadows, because they are the one thing drawn flat on the
     * ground: a shadow's screen position inverts exactly back to the world point it was
     * drawn at, so the order they were painted in is readable from the recording. Reading it
     * off the bodies instead compares roofs against wheels and says nothing.
     *
     * The claim is about `viewDepth`, not about screen y. Screen y alone was what this used
     * to check, and it held only because the sort ignored both the shear and the height —
     * once a near thing east of a far thing can be drawn later, a run of shadows climbing
     * the screen is no longer what "sorted" means.
     */
    const shadows = frame(yard(600))
      .opsOf("ellipse")
      .map((entry) => {
        const y = toWorldY(view, entry.args[1] as number);
        return viewDepth(toWorldX(view, entry.args[0] as number, y), y);
      });
    expect(shadows.length).toBeGreaterThan(3);

    for (let index = 1; index < shadows.length; index++) {
      expect(shadows[index]!, `shadow ${index}`).toBeLessThanOrEqual(
        shadows[index - 1]! + 0.01,
      );
    }
  });

  it("stands a shed's front wall under its own roof", () => {
    /*
     * The direct regression test for "roofs aren't attached to walls".
     *
     * The wall's boxes are measured from the front plane, which is where the drawable's pose
     * already puts them — they were also measured from the shed's centre, so the offset went
     * on twice and the wall stood a whole depth in front of the building it belongs to.
     *
     * Checked in world units rather than on screen, because that is where the mistake is:
     * the eaves oversail the wall by `SHED.eaves` and by nothing else.
     */
    const walls = shedFrontBoxes(SHED_STRUCTURE);
    const roof = shedRoofBox(SHED_STRUCTURE);

    expect(walls.every((box) => box.at[1] === 0)).toBe(true);
    expect(Math.max(...walls.map((box) => box.at[2] + box.size[2]))).toBe(
      SHED_STRUCTURE.height,
    );

    // The roof starts where the walls stop, and oversails them by the eaves on every side.
    expect(roof.at[2]).toBe(SHED_STRUCTURE.height);
    expect(roof.at[0]).toBe(-SHED.eaves);
    expect(roof.at[1]).toBe(-SHED.eaves);
    expect(roof.size[1]).toBe(SHED_STRUCTURE.depth + SHED.eaves * 2);
  });

  it("draws a shed's roof after the wall it rests on", () => {
    /*
     * And the ordering half of the same defect. The roof was baked into the static layer, so
     * the front wall — which stands `SHED.eaves` *behind* the roof's fascia — was painted
     * over it, and the wall's own lit top face showed through as a pale band. `order: "over"`
     * is what makes a roof win against everything it spans.
     */
    const pose = at(SHED_STRUCTURE.at, shedFrontY());

    // Nearer the camera is a smaller depth, and nearer is painted later.
    expect(assemblyDepth(pose, [shedRoofBox(SHED_STRUCTURE)], 0, "over")).toBeLessThan(
      assemblyDepth(pose, shedFrontBoxes(SHED_STRUCTURE)),
    );
  });

  it("frames a locomotive standing inside it, doorway and all", () => {
    /*
     * "Front pillars too low", and "engines render behind the wall" — one defect. The wall
     * stands half a shed's depth in front of the road, and depth costs `VIEW.TILT` of screen
     * height, so a doorway level with the top of an engine is a doorway the engine is drawn
     * above. At 40 the lintel came down twenty units into the cab.
     *
     * Measured on screen, because that is the only place the mistake exists: in world units
     * a 40-unit doorway clears a 35-unit locomotive perfectly well.
     */
    const road = RAIL_YARD_SCENE.roads.find((one) => one.id === SHED_STRUCTURE.road)!;
    const lintelUnderside = toScreenY(view, shedFrontY(), SHED.doorHeight);
    const engineTop = toScreenY(
      view,
      road.y + LOCOMOTIVE.width / 2,
      LOCOMOTIVE.chimney!.top,
    );

    // Screen y grows downward, so the lintel has to be the higher of the two.
    expect(lintelUnderside).toBeLessThan(engineTop);
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

describe("assemblyDepth", () => {
  /*
   * The painter's sort key, and the whole of five reported defects. Every one of them was a
   * pair of solids that overlap on screen being ordered by a rule that could not tell them
   * apart, so this is asserted on pairs rather than on numbers.
   */
  const PORTAL_X = GANTRY_STRUCTURE.travel[0];
  const beltY = (
    RAIL_YARD_SCENE.structures.find((one) => one.kind === "conveyor") as Extract<
      SceneStructure,
      { kind: "conveyor" }
    >
  ).at[1];

  it("puts the higher of two boxes standing in one place in front", () => {
    /*
     * "The crane magnet has a z-index problem". The spreader and the container in its jaws
     * share a portal x and a trolley y, so a key that reads depth alone called them equal
     * and insertion order decided — which painted the container's lit top face over the
     * spreader holding it.
     */
    const pose = at(PORTAL_X, beltY);
    const carried = {
      at: [-CONTAINER.size[0] / 2, -CONTAINER.size[1] / 2, CRANE.TRAVEL_Z],
      size: CONTAINER.size,
      fill: "cargo",
    } as const;
    const spreader = {
      at: [
        -GANTRY.spreaderLength / 2,
        -GANTRY.spreaderDepth / 2,
        CRANE.TRAVEL_Z + CONTAINER.size[2],
      ],
      size: [GANTRY.spreaderLength, GANTRY.spreaderDepth, GANTRY.spreaderHeight],
      fill: "metal",
    } as const;

    expect(assemblyDepth(pose, [spreader])).toBeLessThan(
      assemblyDepth(pose, [carried]),
    );
  });

  it("takes a whole vehicle at once, parts and all", () => {
    /*
     * The unit is the assembly, not the box, and this is why. A wagon's frame runs its whole
     * length while its front bogie sits under the east end of it, so the bogie's own centre
     * is nearer the camera than the frame's — sorted apart, the bogie was painted on top of
     * the frame as a grey square. Together they are one solid at one distance.
     */
    const pose = at(1280, TRACK.ROAD_PITCH * 2);
    const frame = WAGON.boxes.find((box) => box.size[0] === WAGON.length)!;
    const bogie = WAGON.boxes[1]!;
    expect(assemblyDepth(pose, [bogie], WAGON.length)).toBeLessThan(
      assemblyDepth(pose, [frame], WAGON.length),
    );
    // The whole wagon is one key, and it lies between the parts that made it up.
    const whole = assemblyDepth(pose, WAGON.boxes, WAGON.length);
    expect(whole).toBeLessThan(assemblyDepth(pose, [WAGON.boxes[0]!], WAGON.length));
    expect(whole).toBeGreaterThan(assemblyDepth(pose, [bogie], WAGON.length));
  });

  it("a canopy wins against the whole of what it spans", () => {
    /*
     * The gantry beam against the leg holding up its near end. Both are keyed at the portal's
     * own x, so depth is all that separates them — and the beam's centre is half the portal's
     * span behind the leg, which is why a centre key painted the leg's lit top face across
     * two thirds of the beam's near end.
     */
    const span = GANTRY_STRUCTURE.far - GANTRY_STRUCTURE.near;
    const beam = {
      at: [-GANTRY.beamWidth / 2, -span - GANTRY.legDepth / 2, GANTRY.height],
      size: [GANTRY.beamWidth, span + GANTRY.legDepth, GANTRY.beamHeight],
      fill: "structureTrim",
    } as const;
    const leg = {
      at: [-GANTRY.legWidth / 2, -GANTRY.legDepth / 2, 0],
      size: [GANTRY.legWidth, GANTRY.legDepth, GANTRY.height],
      fill: "structureTrim",
    } as const;

    const beamPose = at(PORTAL_X, GANTRY_STRUCTURE.far);
    const legPose = at(PORTAL_X, GANTRY_STRUCTURE.near);
    expect(assemblyDepth(beamPose, [beam], 0, "over")).toBeLessThan(
      assemblyDepth(legPose, [leg]),
    );
    // And without the flag it loses, which is the defect this replaced.
    expect(assemblyDepth(beamPose, [beam])).toBeGreaterThan(
      assemblyDepth(legPose, [leg]),
    );
  });

  it("a floor loses against everything standing on it", () => {
    /*
     * The belt deck against a container the crane is lowering onto its head slot. The deck
     * runs most of a thousand units east of the head, so its centre sits well in front of the
     * box — it was painted over the container, which reappeared the moment it was released
     * and became belt freight drawn later. That was the flicker.
     */
    const head = at(1230, beltY);
    const deck = {
      at: [-CONVEYOR.PITCH / 2, -CONVEYOR.WIDTH / 2, 0],
      size: [670 + CONVEYOR.PITCH, CONVEYOR.WIDTH, CONVEYOR.DECK_Z],
      fill: "structureTrim",
    } as const;
    const freight = {
      at: [-CONTAINER.size[0] / 2, -CONTAINER.size[1] / 2, CONVEYOR.DECK_Z],
      size: CONTAINER.size,
      fill: "cargo",
    } as const;

    expect(assemblyDepth(head, [deck], 0, "under")).toBeGreaterThan(
      assemblyDepth(head, [freight]),
    );
    expect(assemblyDepth(head, [deck])).toBeLessThan(assemblyDepth(head, [freight]));
  });
});
