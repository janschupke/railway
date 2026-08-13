/**
 * Everything that does not move, composed once into a cached layer.
 *
 * Sky, skyline, ground, the permanent way and the backs of the buildings depend only on
 * `(scene, view, palette)`, so they are drawn once and blitted per frame. That takes some
 * six hundred tie strokes and forty rail runs out of every frame, which is the difference
 * between this being free on a phone and not.
 *
 * The track is drawn **per road**, not per edge. That is the fix for rails that did not
 * connect: the previous version drew each edge independently end to end with round caps, so
 * where three of them met their ballast bands overdrew each other and their rails
 * terminated at different offsets, leaving a visible kink at every junction. A road is one
 * continuous run of railway and is now drawn as one; a crossover is drawn as its own run and
 * meets the road tangentially, because both are horizontal at their ends by construction.
 */

import { SHED, TRACK, VIEW } from "./config";
import { localToWorld, poseAtDistance, sampleRun, type Pose } from "./geometry";
import type { RailGraph } from "./graph";
import type { YardPalette } from "./palette";
import type { RailScene, SceneStructure } from "./scene";
import { drawBoxes, visible } from "./draw-box";
import { toScreenX, toScreenY, type ViewTransform } from "./view";

/** A polygon of the ground plane, offset either side of a centreline in world depth. */
function fillBand(
  ctx: CanvasRenderingContext2D,
  view: ViewTransform,
  poses: readonly Pose[],
  half: number,
): void {
  ctx.beginPath();
  for (let index = 0; index < poses.length; index++) {
    const [x, y] = localToWorld(poses[index]!, 0, -half);
    const draw = index === 0 ? ctx.moveTo : ctx.lineTo;
    draw.call(ctx, toScreenX(view, x, y), toScreenY(view, y));
  }
  for (let index = poses.length - 1; index >= 0; index--) {
    const [x, y] = localToWorld(poses[index]!, 0, half);
    ctx.lineTo(toScreenX(view, x, y), toScreenY(view, y));
  }
  ctx.closePath();
  ctx.fill();
}

/** A line running along a centreline, offset across it. Used for both rails. */
function strokeRail(
  ctx: CanvasRenderingContext2D,
  view: ViewTransform,
  poses: readonly Pose[],
  offset: number,
): void {
  ctx.beginPath();
  for (let index = 0; index < poses.length; index++) {
    const [x, y] = localToWorld(poses[index]!, 0, offset);
    const draw = index === 0 ? ctx.moveTo : ctx.lineTo;
    draw.call(ctx, toScreenX(view, x, y), toScreenY(view, y));
  }
  ctx.stroke();
}

type TrackRun = {
  readonly poses: readonly Pose[];
  readonly samples: Parameters<typeof poseAtDistance>[0];
  readonly weight: number;
};

/**
 * Ballast, then sleepers, then rails, along one continuous piece of track.
 *
 * Ties are placed by **arc length** through `poseAtDistance`. The previous version indexed
 * the sample table with `Math.round(ratio * (poses.length - 1))`, and a straight has exactly
 * two samples — so every sleeper on it landed on one of the two endpoints and the whole main
 * line was drawn as bare ballast with a dark blob at each end. Straights and curves are now
 * sleepered identically, which is the whole of "horizontal tracks look different from
 * curved ones".
 */
function drawTrack(
  ctx: CanvasRenderingContext2D,
  view: ViewTransform,
  run: TrackRun,
  palette: YardPalette,
): void {
  const { poses, samples, weight } = run;
  const scale = view.scale;

  ctx.save();
  ctx.lineCap = "butt";
  ctx.lineJoin = "round";

  ctx.fillStyle = palette.ballast;
  fillBand(ctx, view, poses, (TRACK.ballastWidth * weight) / 2);

  if (visible(TRACK.tieWidth * weight, scale)) {
    ctx.strokeStyle = palette.tie;
    ctx.lineWidth = Math.max(VIEW.MIN_FEATURE_PX, TRACK.tieWidth * weight * scale);
    const spacing = TRACK.tieSpacing * weight;
    const half = (TRACK.tieLength * weight) / 2;
    for (let at = spacing / 2; at < samples.length; at += spacing) {
      const pose = poseAtDistance(samples, at);
      const [ax, ay] = localToWorld(pose, 0, -half);
      const [bx, by] = localToWorld(pose, 0, half);
      ctx.beginPath();
      ctx.moveTo(toScreenX(view, ax, ay), toScreenY(view, ay));
      ctx.lineTo(toScreenX(view, bx, by), toScreenY(view, by));
      ctx.stroke();
    }
  }

  ctx.strokeStyle = palette.rail;
  ctx.lineWidth = Math.max(VIEW.MIN_FEATURE_PX, TRACK.railWidth * weight * scale);
  const gauge = (TRACK.gauge * weight) / 2;
  strokeRail(ctx, view, poses, -gauge);
  strokeRail(ctx, view, poses, gauge);

  ctx.restore();
}

/**
 * The switch blade at a crossover's foot.
 *
 * Cosmetic, and its absence was most of why the junctions read as two pieces of track
 * meeting rather than as one piece of railway: a real turnout has a pair of tapering rails
 * lying alongside the through road before the curve begins.
 */
function drawBlade(
  ctx: CanvasRenderingContext2D,
  view: ViewTransform,
  pose: Pose,
  weight: number,
  palette: YardPalette,
): void {
  const length = TRACK.bladeLength * weight;
  if (!visible(length, view.scale)) return;

  ctx.save();
  ctx.strokeStyle = palette.rail;
  ctx.lineWidth = Math.max(VIEW.MIN_FEATURE_PX, TRACK.railWidth * weight * view.scale);
  for (const side of [-1, 1]) {
    const [ax, ay] = localToWorld(pose, -length, (side * TRACK.gauge * weight) / 2);
    const [bx, by] = localToWorld(pose, 0, 0);
    ctx.beginPath();
    ctx.moveTo(toScreenX(view, ax, ay), toScreenY(view, ay));
    ctx.lineTo(toScreenX(view, bx, by), toScreenY(view, by));
    ctx.stroke();
  }
  ctx.restore();
}

function drawSky(
  ctx: CanvasRenderingContext2D,
  view: ViewTransform,
  palette: YardPalette,
): void {
  const gradient = ctx.createLinearGradient(0, 0, 0, view.horizonY);
  gradient.addColorStop(0, palette.skyHigh);
  gradient.addColorStop(1, palette.skyLow);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, view.width, Math.max(0, view.horizonY));
}

function drawSkyline(
  ctx: CanvasRenderingContext2D,
  scene: RailScene,
  view: ViewTransform,
  palette: YardPalette,
): void {
  ctx.save();
  ctx.globalAlpha = VIEW.SKYLINE_ALPHA;
  ctx.fillStyle = palette.skyline;
  for (const structure of scene.structures) {
    if (structure.kind !== "tower") continue;
    const [x, y] = structure.at;
    const [width, height] = structure.size;
    const base = toScreenY(view, y);
    ctx.fillRect(
      toScreenX(view, x, y),
      base - height * view.scale,
      width * view.scale,
      height * view.scale,
    );
  }
  ctx.restore();
}

/** The back wall and roof of a shed. Its front is a drawable, so a train can go inside. */
function shedBackBoxes(structure: Extract<SceneStructure, { kind: "shed" }>) {
  const half = structure.depth / 2;
  return [
    {
      at: [0, half - SHED.wallThickness, 0] as const,
      size: [structure.length, SHED.wallThickness, structure.height] as const,
      fill: "structure" as const,
    },
    {
      at: [-SHED.eaves, -half - SHED.eaves, structure.height] as const,
      size: [
        structure.length + SHED.eaves * 2,
        structure.depth + SHED.eaves * 2,
        SHED.roofThickness,
      ] as const,
      fill: "structureTrim" as const,
    },
  ];
}

/** A pose standing still at a world point, facing east. Structures do not have headings. */
const standing = (x: number, y: number): Pose => ({ x, y, angle: 0 });

/**
 * Paints the whole static layer.
 *
 * Painter's order is sky, skyline, ground, track, then the parts of the buildings that
 * nothing can get in front of. Everything else — rolling stock, the crane, the front walls
 * of the sheds — is drawn per frame into the depth sort, because a train can be in front of
 * it or behind it depending on where the train is.
 */
export function composeStaticLayer(
  ctx: CanvasRenderingContext2D,
  scene: RailScene,
  graph: RailGraph,
  view: ViewTransform,
  palette: YardPalette,
): void {
  ctx.clearRect(0, 0, view.width, view.height);
  drawSky(ctx, view, palette);
  drawSkyline(ctx, scene, view, palette);

  ctx.fillStyle = palette.ground;
  ctx.fillRect(0, view.horizonY, view.width, Math.max(0, view.height - view.horizonY));

  /*
   * Roads first, back to front, then the crossovers between them. Back to front so a
   * crossover's ballast laps over the road behind it rather than under it, which is the
   * order the ground itself is in.
   */
  const roads = [...scene.roads].sort((a, b) => b.y - a.y);
  for (const road of roads) {
    if (road.rail === "hidden") continue;
    const samples = sampleRun([road.span[0], road.y], [road.span[1], road.y]);
    drawTrack(
      ctx,
      view,
      {
        poses: samples.poses,
        samples,
        weight: road.rail === "siding" ? TRACK.sidingScale : 1,
      },
      palette,
    );
  }

  const crossovers = [...graph.edges.values()]
    .filter((edge) => edge.kind === "crossover")
    .sort((a, b) => b.samples.start.y - a.samples.start.y);

  for (const edge of crossovers) {
    const weight = edge.rail === "siding" ? TRACK.sidingScale : 1;
    drawTrack(
      ctx,
      view,
      { poses: edge.samples.poses, samples: edge.samples, weight },
      palette,
    );
    drawBlade(ctx, view, edge.samples.start, weight, palette);
  }

  // Buildings, back to front. Only the parts a train can never be in front of.
  const structures = [...scene.structures].sort(
    (a, b) => depthOf(scene, b) - depthOf(scene, a),
  );
  for (const structure of structures) {
    if (structure.kind === "shed") {
      const road = graph.roads.get(structure.road);
      if (!road) continue;
      ctx.save();
      if (road.y > VIEW.HAZE_BEYOND_UNITS) ctx.globalAlpha = VIEW.FAR_STRUCTURE_ALPHA;
      drawBoxes(
        ctx,
        view,
        standing(structure.at, road.y),
        shedBackBoxes(structure),
        palette,
        0,
      );
      ctx.restore();
      continue;
    }
  }
}

function depthOf(scene: RailScene, structure: SceneStructure): number {
  if (structure.kind === "shed") {
    return scene.roads.find((road) => road.id === structure.road)?.y ?? 0;
  }
  if (structure.kind === "gantry") return structure.far;
  if (structure.kind === "tower") return structure.at[1];
  return structure.at[1];
}
