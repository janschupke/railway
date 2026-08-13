/**
 * Everything that does not move: sky, skyline, ground, the permanent way, the sheds, the
 * gantry legs and the signal posts.
 *
 * All of it depends only on `(scene, view, palette)`, so it is composed once into a
 * cached layer and blitted per frame. That takes roughly four hundred tie rectangles and
 * twenty rail strokes out of every frame, which is most of the drawing cost — the moving
 * half is a few dozen fills.
 */

import { GANTRY, PERMANENT_WAY, SHED, SHED_DOOR, SIGNAL, VIEW } from "./config";
import type { Pose } from "./geometry";
import type { RailGraph } from "./graph";
import type { YardPalette } from "./palette";
import type { RailScene, SceneStructure } from "./scene";
import { toScreenX, toScreenY, type ViewTransform } from "./view";

/** A point offset perpendicular to the track's heading, in world units. */
function offsetPose(pose: Pose, by: number): { x: number; y: number } {
  return {
    x: pose.x - Math.sin(pose.angle) * by,
    y: pose.y + Math.cos(pose.angle) * by,
  };
}

function strokeAlong(
  ctx: CanvasRenderingContext2D,
  view: ViewTransform,
  poses: readonly Pose[],
  offset: number,
): void {
  ctx.beginPath();
  poses.forEach((pose, index) => {
    const point = offsetPose(pose, offset);
    const x = toScreenX(view, point.x);
    const y = toScreenY(view, point.y);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

/**
 * Ballast, ties and two rails along one edge.
 *
 * Ties are laid at a fixed spacing in *arc length*, not at a fixed sample count, or a
 * long straight and a tight curve get the same number of sleepers and the curve reads as
 * a different gauge of railway.
 */
function drawTrack(
  ctx: CanvasRenderingContext2D,
  graph: RailGraph,
  view: ViewTransform,
  edgeId: string,
  palette: YardPalette,
): void {
  const edge = graph.edges.get(edgeId);
  if (!edge || edge.rail === "hidden") return;

  const weight = edge.rail === "siding" ? PERMANENT_WAY.sidingScale : 1;
  const poses = edge.samples.poses;

  ctx.lineCap = "round";
  ctx.strokeStyle = palette.ballast;
  ctx.lineWidth = PERMANENT_WAY.ballastHeight * weight * view.scale;
  strokeAlong(ctx, view, poses, 0);

  ctx.strokeStyle = palette.tie;
  ctx.lineWidth = PERMANENT_WAY.tieWidth * weight * view.scale;
  const half = (PERMANENT_WAY.tieLength * weight) / 2;
  const spacing = PERMANENT_WAY.tieSpacing;
  for (let at = spacing / 2; at < edge.length; at += spacing) {
    const ratio = at / edge.length;
    const pose = poses[Math.round(ratio * (poses.length - 1))] ?? edge.samples.start;
    const a = offsetPose(pose, -half);
    const b = offsetPose(pose, half);
    ctx.beginPath();
    ctx.moveTo(toScreenX(view, a.x), toScreenY(view, a.y));
    ctx.lineTo(toScreenX(view, b.x), toScreenY(view, b.y));
    ctx.stroke();
  }

  ctx.strokeStyle = palette.rail;
  ctx.lineWidth = Math.max(
    VIEW.MIN_FEATURE_PX,
    PERMANENT_WAY.railWidth * weight * view.scale,
  );
  const gauge = (PERMANENT_WAY.gauge * weight) / 2;
  strokeAlong(ctx, view, poses, gauge);
  strokeAlong(ctx, view, poses, -gauge);
}

function drawShed(
  ctx: CanvasRenderingContext2D,
  view: ViewTransform,
  at: readonly [number, number],
  size: readonly [number, number],
  bays: number,
  palette: YardPalette,
): void {
  const x = toScreenX(view, at[0]);
  const base = toScreenY(view, at[1]);
  const width = size[0] * view.scale;
  const height = size[1] * view.scale;

  // SHED's parts are fractions of the footprint, so one spec covers every shed size.
  for (const part of SHED.parts) {
    const [px, py, pw, ph] = part.rect;
    ctx.fillStyle = palette[part.fill === "cargo" ? "structure" : part.fill];
    ctx.fillRect(x + px * width, base - (py + ph) * height, pw * width, ph * height);
  }

  ctx.fillStyle = palette.depot;
  const doorWidth = SHED_DOOR.width * width;
  const doorHeight = SHED_DOOR.height * height;
  for (let bay = 0; bay < bays; bay++) {
    const offset = (SHED_DOOR.offset + bay * (SHED_DOOR.width + SHED_DOOR.gap)) * width;
    if (offset + doorWidth > width) break;
    ctx.fillRect(x + offset, base - doorHeight, doorWidth, doorHeight);
  }
}

function drawGantryLegs(
  ctx: CanvasRenderingContext2D,
  view: ViewTransform,
  structure: Extract<SceneStructure, { kind: "gantry" }>,
  palette: YardPalette,
): void {
  ctx.fillStyle = palette.structureTrim;
  const base = toScreenY(view, structure.at[1]);
  const height = GANTRY.height * view.scale;
  const width = GANTRY.legWidth * view.scale;
  for (const x of [structure.at[0], structure.at[0] + structure.span]) {
    ctx.fillRect(toScreenX(view, x) - width / 2, base - height, width, height);
  }
}

/** The post only. The lamp changes colour with the traffic, so it is drawn per frame. */
function drawSignalPost(
  ctx: CanvasRenderingContext2D,
  view: ViewTransform,
  at: readonly [number, number],
  palette: YardPalette,
): void {
  ctx.fillStyle = palette.structureTrim;
  ctx.fillRect(
    toScreenX(view, at[0]) - (SIGNAL.postWidth * view.scale) / 2,
    toScreenY(view, at[1]) - SIGNAL.height * view.scale,
    SIGNAL.postWidth * view.scale,
    SIGNAL.height * view.scale,
  );
}

/**
 * Paints the whole static picture into a layer's context.
 *
 * The painter's order is the file's real content: sky, skyline, ground, the far shed,
 * track, the near shed, gantry legs, signal posts. Everything after this in render.ts
 * goes on top.
 */
export function composeStaticLayer(
  ctx: CanvasRenderingContext2D,
  scene: RailScene,
  graph: RailGraph,
  view: ViewTransform,
  palette: YardPalette,
): void {
  ctx.clearRect(0, 0, view.width, view.height);

  const sky = ctx.createLinearGradient(0, 0, 0, Math.max(1, view.horizonY));
  sky.addColorStop(0, palette.skyHigh);
  sky.addColorStop(1, palette.skyLow);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, view.width, view.horizonY);

  ctx.save();
  ctx.globalAlpha = VIEW.SKYLINE_ALPHA;
  ctx.fillStyle = palette.skyline;
  for (const structure of scene.structures) {
    if (structure.kind !== "tower") continue;
    const width = structure.size[0] * view.scale;
    const height = structure.size[1] * view.scale;
    const base = toScreenY(view, structure.at[1]);
    ctx.fillRect(
      toScreenX(view, structure.at[0]) - width / 2,
      base - height,
      width,
      height,
    );
  }
  ctx.restore();

  ctx.fillStyle = palette.ground;
  ctx.fillRect(0, view.horizonY, view.width, Math.max(0, view.height - view.horizonY));

  /*
   * Sheds back to front, so a nearer one overlaps a further one rather than the other
   * way round. The far ones are hazed for the same reason the skyline is — depth, from
   * alpha rather than from a blur nobody can afford per frame.
   */
  const sheds = scene.structures
    .filter((structure) => structure.kind === "shed")
    .sort((a, b) => b.at[1] - a.at[1]);

  for (const shed of sheds) {
    ctx.save();
    if (shed.at[1] > VIEW.HAZE_ABOVE_UNITS) ctx.globalAlpha = VIEW.FAR_STRUCTURE_ALPHA;
    drawShed(ctx, view, shed.at, shed.size, shed.bays, palette);
    ctx.restore();
  }

  for (const edge of scene.edges) drawTrack(ctx, graph, view, edge.id, palette);

  for (const structure of scene.structures) {
    if (structure.kind === "gantry") drawGantryLegs(ctx, view, structure, palette);
    if (structure.kind === "signal") drawSignalPost(ctx, view, structure.at, palette);
  }
}
