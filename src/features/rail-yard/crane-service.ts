/**
 * The world's half of the crane protocol.
 *
 * `crane.ts` is the machine — three axes, ten legs, and no idea what a train is.
 * This is everything the machine cannot know: which train is waiting, where the wagon it
 * is meant to be serving actually is on the ground right now, which way the belt should be
 * running, and what a latch means for the container that was in the spreader.
 *
 * Kept apart because the split is what lets `crane.ts` be tested without a world at all,
 * and because the accounting below has to happen *outside* the machine — doing it inside
 * meant reading `holding` a line after it had been cleared, which quietly loaded a whole
 * rake with nothing.
 */

import { WAGON } from "./sprites";
import {
  headClear,
  headLoaded,
  putOnBelt,
  takeFromBelt,
  type Conveyor,
} from "./conveyor";
import { assignCrane, releaseCrane, stepCrane, type CraneTarget } from "./crane";
import { poseAlong } from "./graph";
import { wagonNoseDistance } from "./rake";
import type { WorldState } from "./world-state";

/**
 * The crane's target, which only the simulation can work out: where the wagon it is meant
 * to be serving actually is, on the ground, right now.
 */
function craneTarget(world: WorldState): CraneTarget {
  const { conveyor, crane } = world;
  const beltX = conveyor.headX;
  const beltY = conveyor.y;
  // Taking needs a box settled in the head slot; setting one down needs the slot clear.
  const exchangeReady =
    crane.direction === "load" ? headLoaded(conveyor) : headClear(conveyor);

  const train = world.trains.find((candidate) => candidate.id === crane.servingTrainId);
  if (!train) return { wagonX: beltX, wagonY: beltY, beltX, beltY, exchangeReady };

  const nose = wagonNoseDistance(train.distance, crane.wagonIndex);
  const pose = poseAlong(world.graph, train.path, nose - WAGON.length / 2);
  return {
    wagonX: pose?.x ?? beltX,
    wagonY: pose?.y ?? beltY,
    beltX,
    beltY,
    exchangeReady,
  };
}

export function runCrane(world: WorldState, dtMs: number): void {
  const { conveyor, crane }: { conveyor: Conveyor; crane: WorldState["crane"] } = world;

  /*
   * The crane serves one train at a time, and picks up whoever is waiting.
   *
   * Dispatching here rather than in the phase handler matters: a train that arrives while
   * the crane is busy would otherwise stand at the loading road for ever, because nothing
   * would ever come back and offer it a turn. Array order decides, which is what keeps the
   * choice deterministic.
   */
  if (crane.servingTrainId === null) {
    const waiting = world.trains.find(
      (train) =>
        train.kind === "yard" &&
        (train.phase === "loading" || train.phase === "unloading") &&
        train.handled < train.wagons.length,
    );
    if (waiting) {
      assignCrane(crane, waiting.id, waiting.phase === "loading" ? "load" : "unload");
    }
  }

  /*
   * Which way the belt runs, which is the crane's business rather than the belt's own.
   *
   * Unloading needs the head slot clear to set a box into, so the belt carries the line
   * away; anything else needs the head slot stocked, so it feeds. That changes once per
   * train rather than once per frame, which is why there is no hysteresis here.
   */
  conveyor.running =
    crane.servingTrainId !== null && crane.direction === "unload" ? "out" : "in";

  const event = stepCrane(crane, dtMs, craneTarget(world));
  if (event === null) return;

  const train = world.trains.find((candidate) => candidate.id === crane.servingTrainId);
  if (!train) return releaseCrane(crane);
  const wagon = train.wagons[crane.wagonIndex];

  /*
   * Every container is conserved across a latch: one leaves a place and arrives in the
   * spreader, or leaves the spreader and arrives somewhere. There are no exceptions any
   * more. The yard's boundary with the world outside it used to be here, as a box invented
   * when the stack was bare and one destroyed when it was full; it is the far end of the
   * belt now, which is a place, off camera, that freight travels to and from.
   *
   * `holding` staying null is a real outcome rather than a defect: a wagon that turns out
   * to be empty gives the spreader nothing, and nothing is what it puts down.
   */
  if (event === "closed") {
    if (crane.direction === "load") crane.holding = takeFromBelt(conveyor);
    else if (wagon) {
      crane.holding = wagon.cargo;
      wagon.cargo = null;
    }
    return;
  }

  if (crane.direction === "load") {
    if (wagon) wagon.cargo = crane.holding;
  } else if (crane.holding !== null) {
    putOnBelt(conveyor, crane.holding);
  }
  crane.holding = null;
  train.handled += 1;
  crane.wagonIndex += 1;
}
