/**
 * World units to screen pixels. The only file in the feature that knows what a pixel is.
 *
 * The projection is an **orthographic oblique** — a tilted plan seen from a corner:
 *
 *     sx = originX + (x + y * SHEAR) * scale
 *     sy = originY - y * TILT * scale - z * scale
 *
 * Three axes, three different treatments, and each of them is load-bearing. Width is drawn
 * at full scale. **Depth** is foreshortened by TILT *and* carried sideways by SHEAR, so a
 * unit further into the scene lands up and to the right. **Height** is neither: it goes
 * straight up at full scale.
 *
 * The version this replaces mapped depth at the same scale as width, straight up, with no
 * height axis at all — so a road further back was drawn as track climbing a hill and
 * everything standing on it was a side elevation pasted onto a slope.
 *
 * The shear is what makes it a view rather than a plan. Without it the camera sits square
 * in front of the yard and depth runs straight up the screen, which is fine for a wagon and
 * degenerate for anything long that spans depth: the gantry's beam projected exactly onto
 * its own legs and the whole portal read as a lamppost.
 *
 * The map is still affine, so the inverse is closed form and a ground-plane point
 * round-trips exactly — given its depth, which a screen x now genuinely depends on.
 *
 * The fit is **cover with crop**, not contain. Contain looks correct in the abstract and is
 * wrong here: at phone width, 412 CSS px against a 1500-unit scene would put the whole yard
 * into a band with a locomotive too small to read.
 */

import { clamp } from "./geometry";
import { VIEW } from "./config";
import type { RailScene } from "./scene-types";

export type Viewport = {
  /** CSS pixels. The bitmap is these times `dpr`. */
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
};

export type ViewTransform = {
  /** CSS pixels per world unit along x. DPR lives in the canvas transform, not here. */
  readonly scale: number;
  readonly offsetX: number;
  /** Screen y of the ground plane at depth 0 — the nearest running line. */
  readonly originY: number;
  /** Screen y where the sky meets the ground. */
  readonly horizonY: number;
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
};

/**
 * How far the yard reaches up the screen from the nearest rail, in projected units.
 *
 * "Projected units" because depth and height contribute differently: a road `y` back
 * contributes `y * TILT`, and something `z` tall standing on it contributes `z`. Multiply
 * the result by `scale` for pixels.
 *
 * Derived from the scene so moving a road cannot leave the clearance rule below quietly
 * measuring the wrong thing — but deliberately narrower than "the tallest thing drawn".
 * Sheds and towers are scenery standing behind the tracks and the card is allowed to
 * overlap them; including them was the first version and it measured to the top of a
 * background store, which pinned every desktop viewport to MIN_SCALE to protect a building
 * nobody was looking at. What the rule exists to keep clear is where the trains are.
 */
export function trackBandHeight(scene: RailScene, tilt: number = VIEW.TILT): number {
  let top = 0;
  for (const road of scene.roads) {
    top = Math.max(top, road.y * tilt + VIEW.VEHICLE_ALLOWANCE);
  }
  // A gantry straddles the running lines, so it is track furniture rather than scenery.
  for (const structure of scene.structures) {
    if (structure.kind !== "gantry") continue;
    top = Math.max(top, structure.far * tilt + VIEW.GANTRY_ALLOWANCE);
  }
  return top;
}

/**
 * Fits the scene to a canvas box, or returns null if there is no box yet.
 *
 * `null` for a zero-sized viewport is the normal path twice over: the first ResizeObserver
 * callback fires before layout settles, and jsdom reports every element as zero by zero.
 * Both should paint nothing rather than divide by it.
 */
export function fitView(scene: RailScene, viewport: Viewport): ViewTransform | null {
  const { width, height } = viewport;
  if (!(width > 0) || !(height > 0)) return null;

  const dpr = clamp(viewport.dpr > 0 ? viewport.dpr : 1, 1, VIEW.MAX_DPR);
  const band = VIEW.GROUND_INSET_UNITS + trackBandHeight(scene);

  /*
   * Keep the track band clear of the sign-in card where the viewport allows it.
   *
   * Closed form rather than a loop: the clearance is linear in scale, so the largest scale
   * that satisfies it can be solved for directly — and a loop over a float would be a step
   * size nobody could justify. A landscape phone cannot satisfy it at any scale, in which
   * case the clamp lands on MIN_SCALE and a train passes behind the card, which is opaque.
   * That is the worst case, and it should not be the default.
   *
   * CARD_LIFT_PX tracks the bottom padding on the `stage` recipe, which moves the card up
   * by half of it. Get that wrong and this protects a band the card has left.
   */
  const cardBottom =
    (height + Math.min(VIEW.CARD_SAFE_PX.height, height)) / 2 - VIEW.CARD_LIFT_PX;
  const clearanceLimit = (height - cardBottom - VIEW.MIN_BAND_CLEARANCE_PX) / band;

  const scale = clamp(
    Math.min(width / scene.extent.width, clearanceLimit),
    VIEW.MIN_SCALE,
    VIEW.MAX_SCALE,
  );

  const originY = height - VIEW.GROUND_INSET_UNITS * scale;

  return {
    scale,
    /*
     * Centred on the focus point at the yard's *middle* depth, so the shear leans the scene
     * either side of the frame's centre rather than pushing all of it to one edge.
     */
    offsetX:
      width / 2 - (scene.focusX + (scene.extent.height / 2) * VIEW.SHEAR) * scale,
    originY,
    horizonY: originY - scene.horizon * VIEW.TILT * scale,
    width,
    height,
    dpr,
  };
}

/**
 * Width, plus the sideways carry of depth.
 *
 * Every caller passes the world point's depth, because under an oblique projection a screen
 * x is not a function of world x alone — that is the whole difference between a plan and a
 * view from a corner.
 */
export const toScreenX = (view: ViewTransform, x: number, y: number = 0): number =>
  view.offsetX + (x + y * VIEW.SHEAR) * view.scale;

/**
 * Depth pushes up the screen foreshortened; height pushes up the screen in full.
 *
 * Both subtract because screen y grows downward. The two coefficients differing is the
 * entire camera — collapse them and the yard is a plan; drop the first and it is the side
 * elevation this replaced.
 */
export const toScreenY = (view: ViewTransform, y: number, z: number = 0): number =>
  view.originY - y * VIEW.TILT * view.scale - z * view.scale;

/**
 * How far a world point is from the camera, along the direction the camera looks.
 *
 * The third row of the projection, and the one that was missing. `toScreenX` and `toScreenY`
 * say where a point lands; this says which of two points that land on each other is in front,
 * which is the whole of a painter's algorithm.
 *
 * It falls out of the other two. A step that changes neither `sx` nor `sy` moves a point
 * along the **view ray** `v = (-SHEAR, 1, -TILT)`: the first component cancels the shear in
 * `sx` and the third cancels the tilt in `sy`. Depth is the coordinate along that ray, which
 * is `p . v` — larger further away, because a road further back has a larger `y`.
 *
 * Both other terms matter and both were dropped. `z` is why a spreader was painted behind the
 * container hanging off it and a belt deck over the box being lowered onto it: the sort read
 * their depth as equal because they stand at the same place on the ground. `x` is why the
 * shear was carrying the eye east while the sort still believed the camera was square on.
 *
 * Unscaled, and deliberately: this orders things, it does not place them, and a scale factor
 * that multiplies every key changes no comparison.
 */
export const viewDepth = (x: number, y: number, z: number = 0): number =>
  y - x * VIEW.SHEAR - z * VIEW.TILT;

export const toWorldX = (view: ViewTransform, x: number, y: number = 0): number =>
  (x - view.offsetX) / view.scale - y * VIEW.SHEAR;

/** The inverse on the ground plane, where z is zero. Used by nothing but the tests. */
export const toWorldY = (view: ViewTransform, y: number): number =>
  (view.originY - y) / (VIEW.TILT * view.scale);
