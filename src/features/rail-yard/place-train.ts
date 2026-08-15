/**
 * Turning the simulation's answer into things to draw: where a train's vehicles are this
 * frame, and what the freight on them is painted in.
 *
 * The adapter between the two halves of the feature. Everything above it deals in
 * `TrainState` and distances along a path; everything below deals in boxes and poses.
 */

import { SIM } from "./config";
import { CONTAINER, LOCOMOTIVE, WAGON, type Box } from "./sprites";
import type { Freight } from "./conveyor";
import type { Cargo } from "./draw-box";
import { standingDrawable, vehicle, type Drawable } from "./drawable";
import { poseAlong } from "./graph";
import type { YardPalette } from "./palette";
import { wagonNoseDistance } from "./rake";
import type { TrainState, WorldState } from "./world-state";

/** What a container is painted in: its own livery, and its own corrugation. */
const liveryOf = (palette: YardPalette, freight: Freight): Cargo => ({
  colour: palette.freight[freight.colour] ?? palette.metal,
  ribs: freight.ribs,
});

/**
 * A container standing somewhere that is not a wagon: the belt, or the crane's spreader.
 *
 * Ribbed like the ones on the flats, which they were not — `conveyorDrawables` and the
 * carried box both passed no corrugation at all, so freight acquired its panels on being set
 * down and lost them again on being picked up. They travel with the box now.
 */
export function containerAt(
  x: number,
  y: number,
  z: number,
  freight: Freight,
  palette: YardPalette,
): Drawable {
  const box: Box = {
    at: [-CONTAINER.size[0] / 2, -CONTAINER.size[1] / 2, z],
    size: CONTAINER.size,
    fill: "cargo",
  };
  return {
    ...standingDrawable(x, y, [box]),
    cargo: liveryOf(palette, freight),
    ribbed: box,
    ribs: freight.ribs,
  };
}

/**
 * Where a train's vehicles are this frame.
 *
 * `alpha` carries the leftover of the fixed timestep, so the drawn position is interpolated
 * forward from the last simulated one and a 120 Hz display gets smooth motion out of a
 * 50 Hz simulation.
 */
export function placeTrain(
  world: WorldState,
  train: TrainState,
  palette: YardPalette,
  alpha: number,
): Drawable[] {
  // SIM.STEP_MS, not a literal: this interpolates one simulation step forward, so the two
  // have to be the same number. They were not linked, and nothing would have failed if
  // STEP_MS moved — the motion would simply have drifted out of step with the simulation,
  // since both test suites pass their own dtMs and never compare the two.
  const nose = train.distance + train.speed * alpha * (SIM.STEP_MS / 1000);
  const out: Drawable[] = [];

  for (let index = train.wagons.length - 1; index >= 0; index--) {
    const wagon = train.wagons[index]!;
    const pose = poseAlong(world.graph, train.path, wagonNoseDistance(nose, index));
    if (!pose) continue;

    const { cargo } = wagon;
    const container: Box = {
      at: CONTAINER.at,
      size: CONTAINER.size,
      fill: "cargo",
    };

    out.push(
      vehicle(
        pose,
        cargo ? [...WAGON.boxes, container] : WAGON.boxes,
        WAGON.length,
        [WAGON.length, WAGON.width],
        cargo && liveryOf(palette, cargo),
        cargo?.ribs ?? 0,
        cargo ? container : null,
      ),
    );
  }

  const pose = poseAlong(world.graph, train.path, nose);
  if (pose) {
    out.push(
      vehicle(
        pose,
        LOCOMOTIVE.boxes,
        LOCOMOTIVE.length,
        [LOCOMOTIVE.length, LOCOMOTIVE.width],
        null,
        0,
        null,
      ),
    );
  }
  return out;
}
