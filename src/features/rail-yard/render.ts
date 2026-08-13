/**
 * One frame.
 *
 * The static half arrives as an already-composed layer and is blitted; everything drawn
 * here moves. The split is what keeps the per-frame cost to a blit plus a few dozen
 * fills, which is what makes this affordable on a phone.
 */

import { GANTRY, LOCOMOTIVE, SIM, SIGNAL, VIEW, WAGON, YARD } from "./config";
import { drawShadow, drawVehicle, type Cargo } from "./draw-vehicle";
import type { Pose } from "./geometry";
import { poseAlong } from "./graph";
import type { YardPalette } from "./palette";
import type { TrainState, WorldState } from "./simulation";
import { toScreenX, toScreenY, type ViewTransform } from "./view";

export type Layer = {
  readonly ctx: CanvasRenderingContext2D;
  /** What `drawImage` is given. Separate from `ctx` so an OffscreenCanvas fits too. */
  readonly image: CanvasImageSource;
};

/** One vehicle's place in the world, resolved from the train's arc length. */
type Placed = {
  readonly pose: Pose;
  readonly cargo: Cargo | null;
  readonly isLoco: boolean;
};

/**
 * Where a train's vehicles are this frame.
 *
 * `alpha` is the residual of the fixed-step accumulator, so the drawn position runs
 * slightly ahead of the last simulated one. Without it a 120 Hz display shows each
 * simulated step twice and the motion reads as a judder rather than as speed.
 */
function placeTrain(
  world: WorldState,
  train: TrainState,
  palette: YardPalette,
  alpha: number,
): Placed[] {
  const path = train.path;
  if (!path) return [];

  const nose = train.distance + train.speed * alpha * (SIM.STEP_MS / 1000);
  const placed: Placed[] = [];

  const locoPose = poseAlong(world.graph, path, nose);
  if (!locoPose) return [];

  // Wagons first: the list is drawn in order and the locomotive must end up on top of
  // the coupling it shares with the wagon behind it.
  for (let index = train.wagons.length - 1; index >= 0; index--) {
    const wagon = train.wagons[index]!;
    const at =
      nose -
      LOCOMOTIVE.length -
      index * (WAGON.length + YARD.WAGON_GAP) -
      YARD.WAGON_GAP;
    const pose = poseAlong(world.graph, path, at);
    if (!pose) continue;
    const colour = wagon.cargo === null ? undefined : palette.freight[wagon.cargo];
    placed.push({
      pose,
      cargo: colour === undefined ? null : { colour, ribs: wagon.ribs },
      isLoco: false,
    });
  }

  placed.push({ pose: locoPose, cargo: null, isLoco: true });
  return placed;
}

function drawPuffs(
  ctx: CanvasRenderingContext2D,
  world: WorldState,
  view: ViewTransform,
  palette: YardPalette,
): void {
  const [from, to] = YARD.SMOKE_RADIUS;
  ctx.save();
  ctx.fillStyle = palette.smoke;
  for (const puff of world.puffs) {
    const life = puff.ageMs / puff.lifeMs;
    const radius = (from + (to - from) * life) * view.scale;
    if (radius < VIEW.MIN_FEATURE_PX) continue;
    // Fades as it grows, so a puff thins out instead of vanishing on one frame.
    ctx.globalAlpha = Math.max(0, 1 - life);
    ctx.beginPath();
    ctx.arc(toScreenX(view, puff.x), toScreenY(view, puff.y), radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * The gantry's beam, drawn after the trains because it crosses in front of them. Its legs
 * are in the static layer, behind — which is the whole reason the two are separated.
 */
function drawGantryBeam(
  ctx: CanvasRenderingContext2D,
  world: WorldState,
  view: ViewTransform,
  palette: YardPalette,
): void {
  for (const structure of world.graph.scene.structures) {
    if (structure.kind !== "gantry") continue;
    const x = toScreenX(view, structure.at[0]);
    const span = structure.span * view.scale;
    const top = toScreenY(view, structure.at[1] + GANTRY.height);
    const beam = GANTRY.beamHeight * view.scale;

    /*
     * The beam takes the trim colour, not the structure colour. On the light theme the
     * structure fill is white, and a white bar the width of the loading bay drawn in
     * front of every train was the brightest thing in the picture — a backdrop element
     * shouting over the subject it is meant to frame.
     */
    ctx.fillStyle = palette.structureTrim;
    ctx.fillRect(x, top, span, beam);

    ctx.fillStyle = palette.depot;
    const hoist = GANTRY.hoistWidth * view.scale;
    ctx.fillRect(
      x + span / 2 - hoist / 2,
      top + beam,
      hoist,
      GANTRY.hoistDrop * view.scale,
    );
  }
}

/**
 * Signal lamps.
 *
 * Red means the road this signal guards is occupied, which is exactly the condition that
 * makes an approaching train stop — so the lamp is reading the simulation's own state
 * rather than being animated alongside it.
 */
function drawSignalLamps(
  ctx: CanvasRenderingContext2D,
  world: WorldState,
  view: ViewTransform,
  palette: YardPalette,
): void {
  const radius = SIGNAL.lampRadius * view.scale;
  if (radius < VIEW.MIN_FEATURE_PX) return;

  for (const structure of world.graph.scene.structures) {
    if (structure.kind !== "signal") continue;
    ctx.fillStyle = world.occupancy.has(structure.guards)
      ? palette.signalStop
      : palette.signalGo;
    ctx.beginPath();
    ctx.arc(
      toScreenX(view, structure.at[0]),
      toScreenY(view, structure.at[1] + SIGNAL.height),
      radius,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
}

export function drawFrame(
  ctx: CanvasRenderingContext2D,
  layer: Layer | null,
  world: WorldState,
  view: ViewTransform,
  palette: YardPalette,
  alpha: number,
): void {
  ctx.clearRect(0, 0, view.width, view.height);
  if (layer) ctx.drawImage(layer.image, 0, 0, view.width, view.height);

  /*
   * Back to front. World +y is further away, so a higher y is drawn first and a nearer
   * train covers it; x breaks the tie so two trains on the same road stay in a stable
   * order rather than swapping every time their positions cross.
   */
  const placed = world.trains
    .map((train) => placeTrain(world, train, palette, alpha))
    .filter((vehicles) => vehicles.length > 0)
    .sort((a, b) => {
      // The locomotive is last in each list, and it is what a train is sorted by.
      const first = a[a.length - 1]!.pose;
      const second = b[b.length - 1]!.pose;
      return second.y - first.y || first.x - second.x;
    });

  for (const vehicles of placed) {
    for (const vehicle of vehicles) {
      drawShadow(
        ctx,
        view,
        vehicle.pose,
        vehicle.isLoco ? LOCOMOTIVE.length : WAGON.length,
        palette,
      );
    }
    for (const vehicle of vehicles) {
      drawVehicle(
        ctx,
        vehicle.isLoco ? LOCOMOTIVE : WAGON,
        view,
        vehicle.pose,
        palette,
        vehicle.cargo,
      );
    }
  }

  drawGantryBeam(ctx, world, view, palette);
  drawPuffs(ctx, world, view, palette);
  drawSignalLamps(ctx, world, view, palette);
}
