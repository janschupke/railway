/**
 * What the painter sorts, and how far away it decides each one is.
 *
 * The data model rather than the drawing: `drawFrame` builds a list of these, orders it,
 * and only then touches a canvas. Separating the two is what makes the ordering assertable
 * — a sort checked through a rendered frame is checked by accident, because the recording
 * says what was painted and not which of two things the painter believed was nearer.
 */

import type { Box } from "./sprites";
import type { Cargo } from "./draw-box";
import { localToWorld, type Pose } from "./geometry";
import { viewDepth } from "./view";

/**
 * One rigid assembly, and the unit the painter sorts: a vehicle, a wall, a gantry leg.
 *
 * The boxes inside it are drawn in the order they are listed, and that order is the spec's
 * — bottom up, which is how the vehicle specs in config.ts are written. Sorting *inside* an
 * assembly was tried and is wrong: a wagon's frame runs the whole length while its front
 * bogie sits under the east end of it, so the bogie's centre is nearer the camera than the
 * frame's and it was painted on top as a grey square. Two boxes of one object that overlap
 * on screen are stacked, not sorted, and the author already knew the stacking order.
 *
 * So anything that genuinely has to interleave with other objects is its own assembly. That
 * is why a gantry is five of them rather than one: a train passes between its legs.
 *
 * A vehicle carries a `nose` offset because its spec is written forward from the rear
 * coupling while the simulation tracks the leading one.
 */
export type Drawable = {
  readonly pose: Pose;
  readonly boxes: readonly Box[];
  readonly nose: number;
  readonly cargo: Cargo | null;
  /** Set for rolling stock: the footprint that gets a contact shadow. */
  readonly shadow: readonly [length: number, width: number] | null;
  /** Set for a loaded container: the box to draw corrugation on. */
  readonly ribbed: Box | null;
  readonly ribs: number;
  /**
   * How to resolve an assembly too long to be ordered by a point.
   *
   * Its centre decides, for anything roughly as deep as it is wide — which is everything in
   * the yard but three. A gantry beam spans both legs, a shed roof spans both walls, and a
   * belt deck spans the whole line of freight standing on it: their centres sit behind
   * things they are in front of, and in front of things they are behind.
   *
   * So they say which way they resolve. `over` keys on the nearest corner and wins against
   * everything it spans — a canopy. `under` keys on the furthest and loses to all of it — a
   * floor. Both are properties of the object rather than tuning: nothing at the belt is
   * behind the belt, and nothing under a roof is above it.
   */
  readonly order?: "over" | "under";
};

/** A contact shadow, sorted alongside the bodies so two of them stack as their vehicles do. */
export type Contact = {
  readonly key: number;
  readonly pose: Pose;
  readonly size: readonly [length: number, width: number];
};

export const vehicle = (
  pose: Pose,
  boxes: readonly Box[],
  nose: number,
  spec: readonly [number, number],
  cargo: Cargo | null,
  ribs: number,
  ribbed: Box | null,
): Drawable => ({
  pose,
  boxes,
  nose,
  cargo,
  shadow: spec,
  ribbed,
  ribs,
});

/**
 * An assembly that stands still and faces east — a shed wall, a gantry leg, a signal.
 *
 * Named `standingDrawable` rather than `standing`, which is what it was called here while
 * `draw-scene.ts` had a `standing` of its own returning a `Pose`. Two functions, one name,
 * different return types, in files that import from each other: a reader moving between
 * them had no way to tell which one they were looking at.
 */
export const standingDrawable = (
  x: number,
  y: number,
  boxes: readonly Box[],
  order?: Drawable["order"],
): Drawable => ({
  pose: { x, y, angle: 0 },
  boxes,
  nose: 0,
  cargo: null,
  shadow: null,
  ribbed: null,
  ribs: 0,
  order,
});

/**
 * How far an assembly is from the camera.
 *
 * Measured over the box its boxes all fit inside, so a vehicle sorts as the vehicle it is
 * rather than as whichever of its parts happens to lie nearest.
 */
export function assemblyDepth(
  pose: Pose,
  boxes: readonly Box[],
  nose: number = 0,
  order?: Drawable["order"],
): number {
  let west = Infinity;
  let east = -Infinity;
  let right = Infinity;
  let left = -Infinity;
  let floor = Infinity;
  let ceiling = -Infinity;
  for (const box of boxes) {
    west = Math.min(west, box.at[0]);
    east = Math.max(east, box.at[0] + box.size[0]);
    right = Math.min(right, box.at[1]);
    left = Math.max(left, box.at[1] + box.size[1]);
    floor = Math.min(floor, box.at[2]);
    ceiling = Math.max(ceiling, box.at[2] + box.size[2]);
  }
  if (west > east) return viewDepth(pose.x, pose.y);

  if (order === undefined) {
    const [x, y] = localToWorld(pose, (west + east) / 2 - nose, (right + left) / 2);
    return viewDepth(x, y, (floor + ceiling) / 2);
  }

  const over = order === "over";
  let key = over ? Infinity : -Infinity;
  for (const forward of [west - nose, east - nose]) {
    for (const across of [right, left]) {
      const [x, y] = localToWorld(pose, forward, across);
      for (const z of [floor, ceiling]) {
        const corner = viewDepth(x, y, z);
        key = over ? Math.min(key, corner) : Math.max(key, corner);
      }
    }
  }
  return key;
}
