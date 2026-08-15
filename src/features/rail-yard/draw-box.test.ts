import { describe, expect, it } from "vitest";
import { createFakeContext } from "@/test/fake-canvas-2d";
import { PALETTE, at, view } from "@/test/rail-yard";
import { VIEW } from "./config";
import { CONTAINER } from "./sprites";
import {
  drawBox,
  drawRibs,
  drawRope,
  drawShadow,
  visibleFaces,
  type Face,
} from "./draw-box";

/*
 * These four describes lived in `render.test.ts`, which covered three source files at
 * once. `drawRibs`, `drawShadow` and `drawRope` had no block at all there — they were
 * reached only through `drawFrame`, so what they drew was asserted by the frame coming
 * out, which is the same as not being asserted.
 */

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

describe("drawRibs", () => {
  const CONTAINER_BOX = {
    at: [0, -8, 0],
    size: [38, 17, 16],
    fill: "cargo",
  } as const;

  it("draws one stroke per rib, in the trim colour", () => {
    const recorder = createFakeContext();
    drawRibs(recorder.ctx, view, at(700, 88), CONTAINER_BOX, PALETTE, 0, 5);
    expect(recorder.opsOf("stroke")).toHaveLength(5);
    expect(recorder.styles).toContain(PALETTE.locoTrim);
  });

  it("reads its alpha off the sprite rather than a literal", () => {
    // The pair of constants that were declared on CONTAINER and never read. Asserting the
    // value here is what stops the literal coming back the next time this is edited.
    const recorder = createFakeContext();
    drawRibs(recorder.ctx, view, at(700, 88), CONTAINER_BOX, PALETTE, 0, 5);
    expect(recorder.opsOf("set:globalAlpha").map((entry) => entry.args[0])).toContain(
      CONTAINER.ribAlpha,
    );
  });

  it("draws nothing when the ribs would land on each other's pixel", () => {
    // Legibility guard: corrugation finer than a pixel is fill rate and no information.
    const recorder = createFakeContext();
    const tiny = { ...CONTAINER_BOX, size: [0.2, 17, 0.2] } as const;
    drawRibs(recorder.ctx, view, at(700, 88), tiny, PALETTE, 0, 40);
    expect(recorder.opsOf("stroke")).toHaveLength(0);
  });
});

describe("drawShadow", () => {
  it("lays an ellipse on the ground under the vehicle", () => {
    const recorder = createFakeContext();
    drawShadow(recorder.ctx, view, at(700, 88), 40, 20, PALETTE);
    expect(recorder.opsOf("ellipse")).toHaveLength(1);
    expect(recorder.styles).toContain(PALETTE.shadow);
  });

  it("skips a shadow that would be under a pixel across", () => {
    /*
     * Reached by zooming out, not by shrinking the vehicle: `SHADOW_SPREAD` is added to the
     * half-length *before* the scale, so even a zero-length vehicle casts a shadow three
     * units wide at a normal zoom. The guard is about the viewport, which is why the
     * feature's branch coverage sits lower than the rest of the app — these are the misses.
     */
    const recorder = createFakeContext();
    const far = { ...view, scale: VIEW.MIN_FEATURE_PX / 1000 };
    drawShadow(recorder.ctx, far, at(700, 88), 40, 20, PALETTE);
    expect(recorder.opsOf("ellipse")).toHaveLength(0);
  });
});

describe("drawRope", () => {
  it("hangs a vertical line between the two heights it is given", () => {
    const recorder = createFakeContext();
    drawRope(recorder.ctx, view, [700, 88], 120, 20, PALETTE);

    const moves = recorder.ops.filter(
      (entry) => entry.op === "moveTo" || entry.op === "lineTo",
    );
    expect(moves).toHaveLength(2);
    // Same x at both ends: a hoist rope is vertical on screen whatever the projection does
    // to the point it hangs from.
    expect(moves[0]!.args[0]).toBeCloseTo(moves[1]!.args[0] as number);
    expect(moves[0]!.args[1]).not.toBeCloseTo(moves[1]!.args[1] as number);
  });
});
