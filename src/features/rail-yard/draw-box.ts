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

import { GANTRY, VIEW, type Box } from "./config";
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
 * The vertical faces the camera can see at a heading.
 *
 * The camera looks along +y — from the near edge of the scene towards the back — so a
 * vertical face is visible exactly when its outward normal has a negative y component. For
 * a box at heading `a` the four outward normals are `a` (front), `a + pi` (back),
 * `a + pi/2` (left) and `a - pi/2` (right), so the test is one sine per face.
 *
 * Exactly two qualify at a general heading: one end and one side. At the four axis-aligned
 * headings one face is edge-on and contributes nothing, and dropping it is correct rather
 * than a special case — a zero-area quad fills no pixels either way, and excluding it keeps
 * the count honest for the test.
 *
 * Exported because a face-visibility rule tested through a rendered frame is tested by
 * accident. Eight headings against this directly is what actually pins it.
 */
export function visibleFaces(angle: number): readonly Face[] {
  const faces: Face[] = [];
  if (Math.sin(angle) < 0) faces.push("front");
  if (Math.sin(angle + Math.PI) < 0) faces.push("back");
  if (Math.sin(angle + Math.PI / 2) < 0) faces.push("left");
  if (Math.sin(angle - Math.PI / 2) < 0) faces.push("right");
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
  ctx.globalAlpha = 0.24;
  ctx.strokeStyle = palette.locoTrim;
  ctx.lineWidth = Math.max(VIEW.MIN_FEATURE_PX, view.scale);
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
