/**
 * The exhaust: where a puff is born, and what becomes of it.
 *
 * A three-function particle system with a config surface — the `YARD.SMOKE_*` group — that
 * nothing else reads. It lived in the middle of `simulation.ts` between the braking curve
 * and the crane protocol, which is three unrelated subjects in one scroll.
 *
 * Puffs rise in **z** rather than in depth. Adding the rise to `y` would walk the smoke
 * backwards into the scene and eventually behind the sheds, which is what happens when
 * "up the screen" and "further away" are allowed to be the same axis.
 */

import { LOCOMOTIVE, YARD } from "./config";
import { localToWorld, type Pose } from "./geometry";
import { poseAlong } from "./graph";
import type { Rng } from "./rng";
import type { Puff, TrainState, WorldState } from "./world-state";

/** Where the locomotive's chimney is, in the world. Rotated, and rising in z. */
function chimneyAt(world: WorldState, train: TrainState): Pose & { z: number } {
  const nose = poseAlong(world.graph, train.path, train.distance);
  const chimney = LOCOMOTIVE.chimney!;
  if (!nose) return { x: 0, y: 0, angle: 0, z: chimney.top };
  const [x, y] = localToWorld(nose, chimney.at - LOCOMOTIVE.length, 0);
  return { x, y, angle: nose.angle, z: chimney.top };
}

export function emitSmoke(world: WorldState, train: TrainState, rng: Rng): void {
  if (train.sinceSmoke < YARD.SMOKE_INTERVAL_UNITS) return;
  train.sinceSmoke = 0;
  if (world.puffs.length >= YARD.MAX_PUFFS) return;

  const at = chimneyAt(world, train);
  world.puffs.push({
    x: at.x,
    y: at.y,
    z: at.z,
    // Trailing behind, which is what makes a stack at the front legible as the front.
    driftX: -Math.cos(at.angle) * YARD.SMOKE_TRAIL * (0.6 + rng() * 0.8),
    ageMs: 0,
    lifeMs: YARD.SMOKE_LIFE_MS * (0.7 + rng() * 0.6),
  });
}

export function ageSmoke(world: WorldState, dtMs: number): void {
  const seconds = dtMs / 1000;
  const alive: Puff[] = [];
  for (const puff of world.puffs) {
    puff.ageMs += dtMs;
    if (puff.ageMs >= puff.lifeMs) continue;
    puff.z += YARD.SMOKE_RISE * seconds;
    puff.x += puff.driftX * seconds;
    alive.push(puff);
  }
  world.puffs = alive;
}
