/**
 * The shape of everything solid in the yard, as data.
 *
 * Split from `config.ts`, which is a tuning file: these are not numbers anyone turns to
 * make the animation feel better, they are what a locomotive *is*. `config.ts`'s own header
 * conceded as much — "the sprite geometry is here for the same reason, it is the shape of
 * the scene, and the scene is data" — which is an argument for a file rather than for a
 * section.
 *
 * The tuned numbers stay where architecture.md says they belong, in `config.ts`, and this
 * changes nothing about that rule: a number that only moves a pixel still lives in the
 * feature rather than in `src/lib/constants.ts`.
 */

import type { PaletteKey } from "./palette";

/**
 * A box in vehicle-local units: **x forward** from the rear coupling, **y to the left**,
 * **z up** from the rail head. `cargo` defers to a container's own colour.
 *
 * Deliberately a closed spec rather than a drawing language. A general one would be Canvas
 * reimplemented with worse ergonomics, and it would move the renderer's test claim from
 * "it drew a locomotive" to "the spec says locomotive". But rolling stock, sheds, gantry
 * legs and signal posts really are all boxes, so this much turns every solid in the scene
 * into data and collapses the branch count with them.
 *
 * A box rather than a rectangle is also what makes the mirroring defect unexpressible: the
 * corners are rotated into *world* space and projected, so there is no local coordinate
 * system left to flip. The version this replaces rotated the canvas by the heading, which
 * turned every westbound locomotive upside down.
 */
export type Box = {
  readonly at: readonly [x: number, y: number, z: number];
  readonly size: readonly [length: number, width: number, height: number];
  readonly fill: PaletteKey | "cargo";
};

export type VehicleSpec = {
  readonly length: number;
  readonly width: number;
  readonly boxes: readonly Box[];
  readonly chimney?: {
    /** Local x of the stack's centre, and the local z its top reaches. */
    readonly at: number;
    readonly top: number;
  };
};

/**
 * A boxcab. The hood and its stack lead; the cab is at the back.
 *
 * The stack was at local x 15 of 62 in the first version, which put it behind the cab in
 * the direction of travel — a locomotive running backwards with its exhaust trailing off
 * the wrong end. It is at 46 now.
 */
export const LOCOMOTIVE: VehicleSpec = {
  length: 62,
  width: 22,
  boxes: [
    { at: [6, -9, 0], size: [16, 18, 3], fill: "metal" }, // rear bogie
    { at: [40, -9, 0], size: [16, 18, 3], fill: "metal" }, // front bogie
    { at: [0, -3, 4], size: [3, 6, 4], fill: "metal" }, // rear coupling
    { at: [59, -3, 4], size: [3, 6, 4], fill: "metal" }, // front coupling
    { at: [0, -11, 3], size: [62, 22, 4], fill: "metal" }, // frame
    { at: [2, -10, 7], size: [58, 20, 11], fill: "loco" }, // body
    /*
     * The cab, in three courses with the glazing between them.
     *
     * It was one 13-tall box with a 6-tall trim box inside it, and a box inside another box
     * is not a thing this walker can draw: every box gets a top face, so the band's dark lit
     * top was painted straight across the cab's side three units under the real roof. What
     * you saw was a black roof at the wrong height, which is exactly what it was.
     *
     * Three courses stack instead of nesting, and the one above covers the top face of the
     * one below — a top face and the box standing on it project to the same outline.
     */
    { at: [8, -10, 18], size: [20, 20, 4], fill: "loco" }, // cab, below the glass
    { at: [8, -10, 22], size: [20, 20, 6], fill: "locoTrim" }, // glazing band
    { at: [8, -10, 28], size: [20, 20, 3], fill: "loco" }, // cab roof
    { at: [34, -8, 18], size: [24, 16, 9], fill: "loco" }, // hood
    { at: [43, -3, 27], size: [6, 6, 8], fill: "metal" }, // stack
  ],
  chimney: { at: 46, top: 35 },
} as const;

/** A flat wagon. A container sits on the deck when the crane has put one there. */
export const WAGON: VehicleSpec = {
  length: 46,
  width: 20,
  boxes: [
    { at: [5, -8, 0], size: [13, 16, 3], fill: "metal" },
    { at: [28, -8, 0], size: [13, 16, 3], fill: "metal" },
    { at: [0, -3, 4], size: [3, 6, 4], fill: "metal" },
    { at: [43, -3, 4], size: [3, 6, 4], fill: "metal" },
    { at: [0, -10, 3], size: [46, 20, 4], fill: "metal" },
    { at: [2, -9, 7], size: [42, 18, 3], fill: "structureTrim" }, // deck
  ],
} as const;

/**
 * The box on a loaded wagon, in the same vehicle-local frame.
 *
 * `deck` is where the crane must lower a spreader to, so the height the hoist stops at is
 * derived from the wagon rather than authored twice.
 */
export const CONTAINER = {
  at: [4, -8.5, 10],
  size: [38, 17, 16],
  deck: 10,
  /** Corrugation, drawn as the trim colour at reduced alpha rather than a second token. */
  ribAlpha: 0.24,
  ribWidth: 1,
  ribs: [5, 8],
} as const;

/**
 * A through engine shed. The depot road runs in one end and out the other.
 *
 * Split in the renderer rather than here: the back wall and roof go into the static layer
 * and the front wall enters the depth sort, so a locomotive standing inside is genuinely
 * occluded by the building instead of being painted on top of it.
 */
export const SHED = {
  wallThickness: 4,
  /**
   * Height the doorways reach; the lintel is everything above it.
   *
   * Sized in **screen** terms rather than world ones, which is why it is so much taller than
   * the locomotive it has to frame. The front wall stands half a shed's depth in front of the
   * road, and depth costs `VIEW.TILT` of screen height, so a doorway level with the top of an
   * engine is a doorway the engine's cab is drawn above. What it has to clear is the far top
   * corner of the tallest thing on the road:
   *
   *     LOCOMOTIVE.chimney.top + (depth / 2 + width / 2) * VIEW.TILT = 35 + 26.4 = 61.4
   *
   * It was 40, so the lintel came down twenty units into the locomotive standing inside and
   * cut the cab off — "front pillars too low", and the same defect again as "engines render
   * behind the wall". render.test.ts checks the clearance rather than the number.
   *
   * The height on its own was never the whole of it, though: the back wall was painted in the
   * same colour as the piers, so the doorway had no edge and the piers looked like whatever
   * length of them stood below it. See `structureShade` in palette.ts.
   */
  doorHeight: 68,
  /** Width of a pier between two doorways, world units. */
  pierWidth: 12,
  roofThickness: 5,
  /** How far the roof oversails the walls, world units. */
  eaves: 4,
} as const;

/**
 * The travelling gantry that straddles both loading roads.
 *
 * `height` clears the tallest thing that passes under it, which is a loaded wagon at 26
 * plus the spreader. At 46 the beam grazed a container and read as a bar laid across the
 * rake rather than as a structure over it.
 */
export const GANTRY = {
  legWidth: 12,
  legDepth: 12,
  /** The box girder, along the track. Wide enough to read as a beam, not as a wire. */
  beamWidth: 16,
  height: 86,
  beamHeight: 10,
  trolleyLength: 20,
  trolleyDepth: 22,
  trolleyHeight: 8,
  /** The spreader on the end of the hoist rope. */
  spreaderLength: 40,
  spreaderDepth: 18,
  spreaderHeight: 3,
  ropeWidth: 1.4,
} as const;

/** A signal post and its lamp. */
export const SIGNAL = {
  postWidth: 3,
  postDepth: 3,
  height: 30,
  lampRadius: 3.4,
} as const;

/**
 * Rails, ties and ballast — all of it now lying in the ground plane rather than standing
 * up in an elevation, which is what lets a road and the crossover leaving it share a
 * tangent and therefore join without a seam.
 */
export const TRACK = {
  /** Distance between adjacent roads, world units. The scene's one spacing constant. */
  ROAD_PITCH: 46,
  /** Width of the ballast shoulder, across the track. */
  ballastWidth: 30,
  /** Rail centres, across the track. */
  gauge: 9,
  railWidth: 1.7,
  tieSpacing: 9,
  tieLength: 17,
  tieWidth: 2.6,
  /** A siding is lighter track than the main line. */
  sidingScale: 0.85,
  /**
   * How long a switch blade is drawn at a crossover's foot. Cosmetic, but its absence was
   * most of why the junctions read as two pieces of track meeting rather than as one piece
   * of railway.
   *
   * There is no `frogLength` beside it any more. It was declared for the vee of a diamond
   * and never read once, because this scene has no diamond to draw one at — the roads are
   * joined by a ladder, and a ladder has no crossing in it (`scene.ts`). A number
   * describing geometry the scene cannot contain is not a setting.
   */
  bladeLength: 26,
} as const;
