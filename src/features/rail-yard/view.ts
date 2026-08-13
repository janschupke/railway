/**
 * World units to screen pixels. The only file in the feature that knows what a pixel is.
 *
 * The fit is **cover with crop**, not contain. Contain looks correct in the abstract and
 * is wrong here: at phone width, 412 CSS px against a 1200-unit scene puts the whole yard
 * into a 144 px band with a 16 px locomotive. Cropping instead has a pleasing
 * consequence — the exits are off-screen because the camera does not reach them, rather
 * than because of a special case anywhere in the simulation.
 */

import { clamp } from "./geometry";
import { VIEW } from "./config";
import type { RailScene } from "./scene";

export type Viewport = {
  /** CSS pixels. The bitmap is these times `dpr`. */
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
};

export type ViewTransform = {
  /** CSS pixels per world unit. DPR is applied by the canvas transform, not here. */
  readonly scale: number;
  readonly offsetX: number;
  /** Screen y of world y = 0, which is the main line. */
  readonly groundY: number;
  /** Screen y where the sky meets the ground. */
  readonly horizonY: number;
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
};

/**
 * How far the *running lines* reach above the main line, in world units.
 *
 * Derived from the scene so moving a road cannot leave the clearance rule below quietly
 * measuring the wrong thing — but deliberately narrower than "the tallest thing drawn".
 *
 * Sheds and towers are scenery standing behind the tracks, and the card is allowed to
 * overlap them; including them was the first version and it measured to the top of a
 * background store forty units above the furthest siding, which pinned every desktop
 * viewport to MIN_SCALE to protect a building nobody was looking at. What the rule exists
 * to keep clear is where the trains are.
 */
export function trackBandHeight(scene: RailScene): number {
  let top = 0;
  for (const node of scene.nodes) {
    top = Math.max(top, node.at[1] + VIEW.VEHICLE_ALLOWANCE);
  }
  // A gantry straddles a running line, so it is track furniture rather than scenery.
  for (const structure of scene.structures) {
    if (structure.kind !== "gantry") continue;
    top = Math.max(top, structure.at[1] + VIEW.GANTRY_ALLOWANCE);
  }
  return top;
}

/**
 * Fits the scene to a canvas box, or returns null if there is no box yet.
 *
 * `null` for a zero-sized viewport is the normal path twice over: the first
 * ResizeObserver callback fires before layout settles, and jsdom reports every element
 * as zero by zero. Both should paint nothing rather than divide by it.
 */
export function fitView(scene: RailScene, viewport: Viewport): ViewTransform | null {
  const { width, height } = viewport;
  if (!(width > 0) || !(height > 0)) return null;

  const dpr = clamp(viewport.dpr > 0 ? viewport.dpr : 1, 1, VIEW.MAX_DPR);
  const band = VIEW.GROUND_INSET_UNITS + trackBandHeight(scene);

  /*
   * Keep the track band clear of the sign-in card where the viewport allows it.
   *
   * Closed form rather than a loop: the clearance is linear in scale, so the largest
   * scale that satisfies it can be solved for directly — and a loop over a float would
   * be a step size nobody could justify. A landscape phone cannot satisfy it at any
   * scale, in which case the clamp lands on MIN_SCALE and a train passes behind the
   * card, which is opaque. That is the worst case, and it should not be the default.
   */
  const cardBottom = (height + Math.min(VIEW.CARD_SAFE_PX.height, height)) / 2;
  const clearanceLimit = (height - cardBottom - VIEW.MIN_BAND_CLEARANCE_PX) / band;

  const scale = clamp(
    Math.min(width / scene.extent.width, clearanceLimit),
    VIEW.MIN_SCALE,
    VIEW.MAX_SCALE,
  );

  const groundY = height - VIEW.GROUND_INSET_UNITS * scale;

  return {
    scale,
    // Centred on the focus point: desktop shows the approaches, a phone crops to the bay.
    offsetX: width / 2 - scene.focusX * scale,
    groundY,
    horizonY: groundY - scene.horizon * scale,
    width,
    height,
    dpr,
  };
}

export const toScreenX = (view: ViewTransform, x: number): number =>
  view.offsetX + x * view.scale;

/** World +y is up-screen and further away, so it subtracts. */
export const toScreenY = (view: ViewTransform, y: number): number =>
  view.groundY - y * view.scale;

export const toWorldX = (view: ViewTransform, x: number): number =>
  (x - view.offsetX) / view.scale;

export const toWorldY = (view: ViewTransform, y: number): number =>
  (view.groundY - y) / view.scale;
