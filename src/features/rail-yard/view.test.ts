import { describe, expect, it } from "vitest";
import { VIEW } from "./config";
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

  it("centres on the scene's focus point", () => {
    for (const viewport of [DESKTOP, PHONE]) {
      const view = fitView(scene, viewport)!;
      expect(toScreenX(view, scene.focusX)).toBeCloseTo(viewport.width / 2);
    }
  });

  it("anchors the main line to the bottom edge", () => {
    const view = fitView(scene, DESKTOP)!;
    expect(view.groundY).toBeCloseTo(
      DESKTOP.height - VIEW.GROUND_INSET_UNITS * view.scale,
    );
    // World y grows up-screen, so the depot road sits above the main line.
    expect(toScreenY(view, 124)).toBeLessThan(toScreenY(view, 0));
  });

  it("puts the horizon above the yard and the sky above that", () => {
    const view = fitView(scene, DESKTOP)!;
    expect(view.horizonY).toBeLessThan(view.groundY);
    expect(view.horizonY).toBeCloseTo(view.groundY - scene.horizon * view.scale);
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
      const cardBottom = (height + VIEW.CARD_SAFE_PX.height) / 2;
      expect(bandTop - cardBottom, `height ${height}`).toBeGreaterThanOrEqual(
        VIEW.MIN_BAND_CLEARANCE_PX,
      );
    }
  });

  it("gives up the clearance rather than the legibility floor on a short viewport", () => {
    /*
     * A landscape phone cannot satisfy the clearance at any scale. Shrinking past
     * MIN_SCALE to buy it would trade a readable yard for a rule about a card that is
     * opaque anyway, so the floor wins and a train passes behind the card.
     */
    const squat = fitView(scene, { width: 740, height: 300, dpr: 1 })!;
    expect(squat.scale).toBe(VIEW.MIN_SCALE);
  });
});

describe("trackBandHeight", () => {
  const bare = { ...scene, nodes: [{ id: "n", at: [0, 20], kind: "bay" }] } as const;

  it("measures to the top of a train on the furthest running line", () => {
    const band = trackBandHeight(scene);
    const highestNode = Math.max(...scene.nodes.map((node) => node.at[1]));
    expect(band).toBe(highestNode + VIEW.VEHICLE_ALLOWANCE);
    expect(band).toBeLessThan(scene.horizon);
  });

  it("ignores scenery standing behind the tracks", () => {
    /*
     * A shed forty units taller than the furthest siding must not pull the band up with
     * it. Including sheds was the first version and it pinned every desktop viewport to
     * MIN_SCALE to hold the card clear of a building behind the yard.
     */
    const withShed = trackBandHeight({
      ...bare,
      structures: [
        { kind: "shed", at: [0, 400], size: [10, 90], bays: 1 },
        { kind: "tower", at: [0, 300], size: [10, 200] },
      ],
    });
    expect(withShed).toBe(20 + VIEW.VEHICLE_ALLOWANCE);
  });

  it("counts a gantry, which straddles a running line", () => {
    const withGantry = trackBandHeight({
      ...bare,
      structures: [{ kind: "gantry", at: [0, 200], span: 10 }],
    });
    expect(withGantry).toBe(200 + VIEW.GANTRY_ALLOWANCE);
  });
});

describe("the screen and world transforms", () => {
  it("round-trip", () => {
    const view = fitView(scene, DESKTOP)!;
    for (const [x, y] of [
      [0, 0],
      [560, 62],
      [1200, 300],
      [-190, 0],
    ] as const) {
      expect(toWorldX(view, toScreenX(view, x))).toBeCloseTo(x);
      expect(toWorldY(view, toScreenY(view, y))).toBeCloseTo(y);
    }
  });
});
