import { describe, expect, it } from "vitest";
import { TRACK, VIEW } from "./config";
import { RAIL_YARD_SCENE } from "./scene";
import {
  fitView,
  toScreenX,
  toScreenY,
  toWorldX,
  toWorldY,
  trackBandHeight,
} from "./view";

const scene = RAIL_YARD_SCENE;

/** A desktop content column, and a Pixel 7 with the chrome taken off. */
const DESKTOP = { width: 896, height: 620, dpr: 1 };
const PHONE = { width: 412, height: 620, dpr: 2.625 };

describe("fitView", () => {
  it("returns nothing for a box with no size", () => {
    // The normal path twice over: the first ResizeObserver callback fires before layout
    // settles, and jsdom reports every element as zero by zero.
    expect(fitView(scene, { width: 0, height: 400, dpr: 1 })).toBeNull();
    expect(fitView(scene, { width: 400, height: 0, dpr: 1 })).toBeNull();
    expect(fitView(scene, { width: -10, height: -10, dpr: 1 })).toBeNull();
  });

  it("keeps the scale inside its legibility bounds at any width", () => {
    for (const width of [200, 412, 896, 1600, 3200]) {
      const view = fitView(scene, { width, height: 620, dpr: 1 })!;
      expect(view.scale, `width ${width}`).toBeGreaterThanOrEqual(VIEW.MIN_SCALE);
      expect(view.scale, `width ${width}`).toBeLessThanOrEqual(VIEW.MAX_SCALE);
    }
  });

  it("fills a desktop column exactly and crops a phone", () => {
    const desktop = fitView(scene, { ...DESKTOP, height: 800 })!;
    expect(desktop.scale).toBeCloseTo(DESKTOP.width / scene.extent.width);

    // Cover with crop, not contain: at phone width a contained fit would put the whole
    // yard in a band with a locomotive too small to read.
    const phone = fitView(scene, PHONE)!;
    expect(phone.scale).toBe(VIEW.MIN_SCALE);
    expect(scene.extent.width * phone.scale).toBeGreaterThan(PHONE.width);
  });

  it("centres on the scene's focus point, at the yard's middle depth", () => {
    /*
     * The depth matters because of the shear: a screen x is a function of both world axes,
     * so "centred on focusX" has to name a depth to mean anything. Taking the middle leans
     * the scene either side of the frame's centre rather than pushing all of it to one edge.
     */
    const middle = scene.extent.height / 2;
    for (const viewport of [DESKTOP, PHONE]) {
      const view = fitView(scene, viewport)!;
      expect(toScreenX(view, scene.focusX, middle)).toBeCloseTo(viewport.width / 2);
    }
  });

  it("carries depth sideways as well as up", () => {
    // Without this the camera is square in front of the yard and anything spanning depth —
    // the gantry beam, most obviously — projects onto itself and reads as a vertical bar.
    const view = fitView(scene, DESKTOP)!;
    expect(toScreenX(view, 0, TRACK.ROAD_PITCH)).toBeGreaterThan(toScreenX(view, 0, 0));
  });

  it("anchors the nearest running line to the bottom edge", () => {
    const view = fitView(scene, DESKTOP)!;
    expect(view.originY).toBeCloseTo(
      DESKTOP.height - VIEW.GROUND_INSET_UNITS * view.scale,
    );
    // Depth grows away from the camera, so the depot road sits above the main line.
    expect(toScreenY(view, TRACK.ROAD_PITCH * 4)).toBeLessThan(toScreenY(view, 0));
  });

  it("puts the horizon above the yard and the sky above that", () => {
    const view = fitView(scene, DESKTOP)!;
    expect(view.horizonY).toBeLessThan(view.originY);
    expect(view.horizonY).toBeCloseTo(
      view.originY - scene.horizon * VIEW.TILT * view.scale,
    );
  });

  it("gives a taller viewport more sky rather than a bigger yard", () => {
    // Both heights clear the card rule, so scale is decided by width alone and the extra
    // pixels all go above the horizon.
    const short = fitView(scene, { ...DESKTOP, height: 800 })!;
    const tall = fitView(scene, { ...DESKTOP, height: 1100 })!;
    expect(tall.scale).toBe(short.scale);
    expect(tall.height - tall.horizonY).toBeCloseTo(short.height - short.horizonY);
    expect(tall.horizonY).toBeGreaterThan(short.horizonY);
  });

  it("caps the device pixel ratio", () => {
    // A Pixel 7 reports 2.625; going past 2 triples fill cost for detail nobody resolves.
    expect(fitView(scene, PHONE)!.dpr).toBe(VIEW.MAX_DPR);
    expect(fitView(scene, { ...DESKTOP, dpr: 0 })!.dpr).toBe(1);
    expect(fitView(scene, { ...DESKTOP, dpr: 1.5 })!.dpr).toBe(1.5);
  });

  it("keeps the track band clear of the sign-in card where it can", () => {
    for (const height of [620, 800, 1100]) {
      const view = fitView(scene, { ...DESKTOP, height })!;
      const bandTop =
        height - (VIEW.GROUND_INSET_UNITS + trackBandHeight(scene)) * view.scale;
      const cardBottom = (height + VIEW.CARD_SAFE_PX.height) / 2 - VIEW.CARD_LIFT_PX;
      expect(bandTop - cardBottom, `height ${height}`).toBeGreaterThanOrEqual(
        VIEW.MIN_BAND_CLEARANCE_PX,
      );
    }
  });

  it("gives up the clearance rather than the legibility floor on a short viewport", () => {
    /*
     * A landscape phone cannot satisfy the clearance at any scale. Shrinking past MIN_SCALE
     * to buy it would trade a readable yard for a rule about a card that is opaque anyway,
     * so the floor wins and a train passes behind the card.
     */
    const squat = fitView(scene, { width: 740, height: 300, dpr: 1 })!;
    expect(squat.scale).toBe(VIEW.MIN_SCALE);
  });
});

describe("the projection", () => {
  const view = fitView(scene, DESKTOP)!;

  it("foreshortens depth", () => {
    // The camera is above the yard, so a unit further back costs less screen than a unit
    // of width. Collapse this to 1 and the yard is a plan.
    const depth = view.originY - toScreenY(view, TRACK.ROAD_PITCH, 0);
    expect(depth).toBeCloseTo(TRACK.ROAD_PITCH * VIEW.TILT * view.scale);
    expect(depth).toBeLessThan(TRACK.ROAD_PITCH * view.scale);
  });

  it("does not foreshorten height", () => {
    /*
     * The asymmetry is the whole camera. A ten-unit post is ten units tall on screen while
     * ten units of depth is five and a half — which is what makes a box look like a box
     * rather than like a rectangle lying on the floor.
     */
    expect(view.originY - toScreenY(view, 0, 10)).toBeCloseTo(10 * view.scale);
  });

  it("keeps adjacent roads apart at the smallest scale it will ever draw", () => {
    /*
     * The numeric defence of TILT. Five roads have to stay separable on a phone, where the
     * scale is pinned at the floor. At 0.30 this reads under four pixels and the yard
     * collapses into stripes.
     */
    const phone = fitView(scene, PHONE)!;
    const gap = toScreenY(phone, 0) - toScreenY(phone, TRACK.ROAD_PITCH);
    expect(gap).toBeGreaterThanOrEqual(VIEW.MIN_FEATURE_PX * 4);
  });

  it("round-trips on the ground plane", () => {
    // Depth is recovered first and then fed back into the x inverse, because under a shear
    // a screen x on its own does not determine a world x.
    for (const [x, y] of [
      [0, 0],
      [640, TRACK.ROAD_PITCH * 2],
      [1500, 560],
      [-320, TRACK.ROAD_PITCH * 4],
    ] as const) {
      const depth = toWorldY(view, toScreenY(view, y));
      expect(depth).toBeCloseTo(y);
      expect(toWorldX(view, toScreenX(view, x, y), depth)).toBeCloseTo(x);
    }
  });
});

describe("trackBandHeight", () => {
  const bare = {
    ...scene,
    roads: [{ id: "r", y: 20, span: [0, 10], rail: "main" }],
  } as const;

  it("measures to the top of a train on the furthest running line", () => {
    const deepest = Math.max(...scene.roads.map((road) => road.y));
    const band = trackBandHeight({ ...scene, structures: [] });
    expect(band).toBeCloseTo(deepest * VIEW.TILT + VIEW.VEHICLE_ALLOWANCE);
    expect(band).toBeLessThan(scene.horizon * VIEW.TILT);
  });

  it("ignores scenery standing behind the tracks", () => {
    /*
     * A shed taller than anything on rails must not pull the band up with it. Including
     * sheds was the first version and it pinned every desktop viewport to MIN_SCALE to hold
     * the card clear of a building behind the yard.
     */
    const withShed = trackBandHeight({
      ...bare,
      structures: [
        { kind: "shed", road: "r", at: 0, length: 10, depth: 10, height: 200, bays: 1 },
        { kind: "tower", at: [0, 300], size: [10, 400] },
      ],
    });
    expect(withShed).toBeCloseTo(20 * VIEW.TILT + VIEW.VEHICLE_ALLOWANCE);
  });

  it("counts a gantry, which straddles a running line", () => {
    const withGantry = trackBandHeight({
      ...bare,
      structures: [{ kind: "gantry", near: 0, far: 200, travel: [0, 10] }],
    });
    expect(withGantry).toBeCloseTo(200 * VIEW.TILT + VIEW.GANTRY_ALLOWANCE);
  });

  it("takes the tilt it is given", () => {
    // fitView passes the real one; a caller sweeping tilts is how the constant was chosen.
    expect(trackBandHeight(scene, 1)).toBeGreaterThan(trackBandHeight(scene, 0.2));
  });
});
