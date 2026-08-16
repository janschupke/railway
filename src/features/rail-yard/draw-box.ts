/**
 * Every solid in the yard, drawn as a box.
 *
 * Rolling stock, containers, sheds, gantry legs, signal posts and the stack are all
 * rectangular prisms, so one walker draws the lot. That is worth more than the code it
 * saves: the corners are rotated into **world** space and projected individually, so there
 * is no local coordinate system left for a heading to flip.
 *
 * That is the fix for the worst-looking defect in the first version. It drew each vehicle
 * by rotating the canvas through the heading and scaling y negative, which is a rigid
 * rotation — and past a quarter turn a rigid rotation is a mirror. Every train on a
 * westbound road came out upside down, body below the rail and shadow floating above it.
 * There is no sign to get wrong here, because there is nothing to negate.
 */

import { VIEW } from "./config";
import { CONTAINER, GANTRY, type Box } from "./sprites";
import { localToWorld, type Pose } from "./geometry";
import type { YardPalette } from "./palette";
import { toScreenX, toScreenY, type ViewTransform } from "./view";

export type Cargo = { readonly colour: string; readonly ribs: number };

/** Which vertical face of a box is which, in the box's own frame. */
export type Face = "front" | "back" | "left" | "right";

type Point = readonly [x: number, y: number];

/** Below this a feature lands on its neighbour's pixel and only costs fill rate. */
export const visible = (size: number, scale: number): boolean =>
  size * scale >= VIEW.MIN_FEATURE_PX;

/**
 * How close to edge-on counts as edge-on, in the units of the dot product below.
 *
 * Twelve orders of magnitude above the rounding error of a `sin`/`cos` pair — which is
 * where the ambiguity actually lives — and seven below a face with any pixels in it.
 */
const EDGE_ON = 1e-9;

/** Each face's outward normal, as a rotation off the box's own heading. */
const FACE_NORMAL: Readonly<Record<Face, number>> = {
  front: 0,
  back: Math.PI,
  left: Math.PI / 2,
  right: -Math.PI / 2,
};

/**
 * The vertical faces the camera can see at a heading.
 *
 * A point moves along the **view ray** without moving on screen, and the projection gives
 * it directly: `sx` is fixed by `x + y * SHEAR` and `sy` by `y * TILT + z`, so a step of
 * `(-SHEAR, 1, -TILT)` changes neither. A face is turned towards the camera exactly when
 * its outward normal `n` satisfies `n . v < 0`, which for a vertical face at world angle
 * `t` is `sin t - cos t * SHEAR`.
 *
 * The shear in that expression is the whole of this fix. Without it the test reads
 * `sin t < 0`, which is the camera as it stood *before* VIEW.SHEAR existed — square in
 * front of the yard. Once depth started carrying the eye sideways the camera moved round to
 * the east, and the stale test failed every east-facing face by exactly the amount it had
 * moved: at heading 0 the nose of a locomotive measures `sin 0 = 0`, misses `< 0` by
 * nothing at all, and is never drawn. That is one line, and it is why containers had no
 * ends, engines had no noses, and every roof read as a plane hovering over its walls
 * rather than as the lid of a box.
 *
 * Exactly two qualify at a general heading — one end and one side — so a box always reads
 * as a solid. At the four headings where a pair is exactly edge-on that pair drops out and
 * one face is left, which is correct rather than a special case: a zero-area quad fills no
 * pixels either way, and excluding it keeps the count honest for the test.
 *
 * **The comparison is against `-EDGE_ON`, not against zero, and that is load-bearing.** At
 * an edge-on heading the expression is zero in exact arithmetic and something within a
 * rounding step of zero in floating point, and which side of zero it lands on is decided by
 * the last bit of `Math.sin` and `Math.cos` — implementation-defined in ECMAScript, and
 * observed differing between two Node builds. A bare `< 0` therefore drew a zero-area quad
 * on one machine and not on another, which is how this passed locally and failed in CI.
 * `EDGE_ON` is far above that noise and far below any face with a pixel in it: a face
 * within 1e-9 radians of edge-on is a quad about a billionth of its own width.
 *
 * The result needs no depth ordering. Both faces are turned towards the camera on a convex
 * solid under an orthographic projection, so they meet along their shared edge and cannot
 * overlap — which matters here because each face takes a translucent shade pass, and an
 * overlap would show up as a double-darkened seam.
 *
 * Exported because a face-visibility rule tested through a rendered frame is tested by
 * accident. Eight headings against this directly is what actually pins it.
 */
export function visibleFaces(angle: number): readonly Face[] {
  const faces: Face[] = [];
  for (const face of ["front", "back", "left", "right"] as const) {
    const at = angle + FACE_NORMAL[face];
    if (Math.sin(at) - Math.cos(at) * VIEW.SHEAR < -EDGE_ON) faces.push(face);
  }
  return faces;
}

/**
 * The eight corners of a box, in world space, at a pose.
 *
 * `at` is the box's near-west-bottom corner in vehicle-local units — x forward from the
 * rear coupling, y to the left, z up from the rail head — and `pose` puts the vehicle's
 * *nose* on the track, which is what the simulation tracks. So local x runs from
 * `at.x - length` behind the pose.
 */
function corners(pose: Pose, box: Box, noseOffset: number): readonly Point[] {
  const [ax, ay] = box.at;
  const [length, width] = box.size;
  const west = ax - noseOffset;
  const east = west + length;
  return [
    localToWorld(pose, west, ay),
    localToWorld(pose, east, ay),
    localToWorld(pose, east, ay + width),
    localToWorld(pose, west, ay + width),
  ];
}

/** The four vertical faces, as pairs of ground-plane corner indices, in corner order. */
const FACE_EDGES: Readonly<Record<Face, readonly [number, number]>> = {
  // Corners run west-right, east-right, east-left, west-left in the local frame.
  back: [3, 0],
  front: [1, 2],
  right: [0, 1],
  left: [2, 3],
};

function polygon(ctx: CanvasRenderingContext2D, points: readonly Point[]): void {
  ctx.beginPath();
  ctx.moveTo(points[0]![0], points[0]![1]);
  for (let index = 1; index < points.length; index++) {
    ctx.lineTo(points[index]![0], points[index]![1]);
  }
  ctx.closePath();
  ctx.fill();
}

/**
 * Draws one box standing at a pose.
 *
 * Painter's order within the box is sides then top, which is correct for any convex solid
 * seen from above: the roof is nearer the camera than every wall below it, so it goes last
 * and the seams disappear under it.
 *
 * Shading is two flat overlays rather than arithmetic on the base colour. This feature may
 * not compute a colour any more than it may write one — a lightened hex here would be the
 * same design-system violation as a literal — so the vertical faces take a shade token and
 * the top takes a lit one, both translucent, both declared in tokens.css and held to a
 * bounded contrast by contrast.test.ts.
 */
export function drawBox(
  ctx: CanvasRenderingContext2D,
  view: ViewTransform,
  pose: Pose,
  box: Box,
  palette: YardPalette,
  noseOffset: number,
  cargo: Cargo | null,
): void {
  const [, , height] = box.size;
  const base =
    box.fill === "cargo" ? (cargo?.colour ?? palette.metal) : palette[box.fill];
  const ground = corners(pose, box, noseOffset);
  const bottom = box.at[2];
  const top = bottom + height;

  const project = (point: Point, z: number): Point => [
    toScreenX(view, point[0], point[1]),
    toScreenY(view, point[1], z),
  ];

  if (visible(height, view.scale)) {
    for (const face of visibleFaces(pose.angle)) {
      const [a, b] = FACE_EDGES[face];
      const first = ground[a]!;
      const second = ground[b]!;
      ctx.fillStyle = base;
      polygon(ctx, [
        project(first, bottom),
        project(second, bottom),
        project(second, top),
        project(first, top),
      ]);
      ctx.fillStyle = palette.faceShade;
      polygon(ctx, [
        project(first, bottom),
        project(second, bottom),
        project(second, top),
        project(first, top),
      ]);
    }
  }

  const roof = ground.map((point) => project(point, top));
  ctx.fillStyle = base;
  polygon(ctx, roof);
  ctx.fillStyle = palette.faceLit;
  polygon(ctx, roof);
}

/** Draws a list of boxes in order. The nose offset is the spec's length for a vehicle. */
export function drawBoxes(
  ctx: CanvasRenderingContext2D,
  view: ViewTransform,
  pose: Pose,
  boxes: readonly Box[],
  palette: YardPalette,
  noseOffset: number,
  cargo: Cargo | null = null,
): void {
  for (const box of boxes) {
    drawBox(ctx, view, pose, box, palette, noseOffset, cargo);
  }
}

/**
 * The corrugation on a container's visible long side.
 *
 * Ribs are the trim colour under a low alpha rather than a second palette entry: they have
 * to work against six container colours in two themes, and any fixed second colour is wrong
 * against at least one of them.
 *
 * Drawn as strokes across the face rather than as boxes, because a rib is a groove and has
 * no thickness worth projecting.
 */
export function drawRibs(
  ctx: CanvasRenderingContext2D,
  view: ViewTransform,
  pose: Pose,
  box: Box,
  palette: YardPalette,
  noseOffset: number,
  ribs: number,
): void {
  const [length, , height] = box.size;
  if (!visible(height, view.scale) || !visible(length / (ribs + 1), view.scale)) return;

  const side = visibleFaces(pose.angle).find(
    (face) => face === "left" || face === "right",
  );
  if (!side) return;

  const [ax, ay] = box.at;
  const across = side === "right" ? ay : ay + box.size[1];
  const bottom = box.at[2];
  const top = bottom + height;

  ctx.save();
  /*
   * Read off the sprite rather than written here. Both numbers were declared on CONTAINER
   * and neither was ever read: the alpha was repeated as a literal that happened to agree,
   * and the width was implied by scaling by 1. A corrugation that only a box has is the
   * box's to describe, and a constant nothing reads is one edit away from disagreeing
   * with the thing it claims to configure.
   */
  ctx.globalAlpha = CONTAINER.ribAlpha;
  ctx.strokeStyle = palette.locoTrim;
  ctx.lineWidth = Math.max(VIEW.MIN_FEATURE_PX, view.scale * CONTAINER.ribWidth);
  for (let rib = 1; rib <= ribs; rib++) {
    const forward = ax - noseOffset + (length * rib) / (ribs + 1);
    const [wx, wy] = localToWorld(pose, forward, across);
    ctx.beginPath();
    ctx.moveTo(toScreenX(view, wx, wy), toScreenY(view, wy, bottom));
    ctx.lineTo(toScreenX(view, wx, wy), toScreenY(view, wy, top));
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * The contact shadow under a vehicle, lying flat on the ground plane.
 *
 * Deliberately not `shadowBlur` — that is the most expensive operation the 2D context has
 * and it would dominate the frame on a phone for a cue this sells just as well. An ellipse
 * on the ground foreshortens with the ground, which is why its minor axis carries the tilt.
 */
export function drawShadow(
  ctx: CanvasRenderingContext2D,
  view: ViewTransform,
  pose: Pose,
  length: number,
  width: number,
  palette: YardPalette,
): void {
  const half = (length / 2 + VIEW.SHADOW_SPREAD) * view.scale;
  if (half < VIEW.MIN_FEATURE_PX) return;

  const [cx, cy] = localToWorld(pose, -length / 2, 0);
  ctx.save();
  ctx.fillStyle = palette.shadow;
  ctx.beginPath();
  ctx.ellipse(
    toScreenX(view, cx, cy),
    toScreenY(view, cy),
    half,
    Math.max(
      VIEW.MIN_FEATURE_PX,
      ((width / 2 + VIEW.SHADOW_SPREAD) * view.scale * VIEW.TILT) / 1,
    ),
    0,
    0,
    Math.PI * 2,
  );
  ctx.fill();
  ctx.restore();
}

/**
 * The hoist rope between the gantry beam and the spreader.
 *
 * A line rather than a box: it is one unit across, so a projected prism would be a
 * sub-pixel sliver at every scale the yard is ever drawn at.
 */
export function drawRope(
  ctx: CanvasRenderingContext2D,
  view: ViewTransform,
  at: readonly [x: number, y: number],
  fromZ: number,
  toZ: number,
  palette: YardPalette,
): void {
  ctx.save();
  ctx.strokeStyle = palette.metal;
  ctx.lineWidth = Math.max(VIEW.MIN_FEATURE_PX, GANTRY.ropeWidth * view.scale);
  ctx.beginPath();
  ctx.moveTo(toScreenX(view, at[0], at[1]), toScreenY(view, at[1], fromZ));
  ctx.lineTo(toScreenX(view, at[0], at[1]), toScreenY(view, at[1], toZ));
  ctx.stroke();
  ctx.restore();
}
