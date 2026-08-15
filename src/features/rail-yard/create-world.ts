/**
 * Building the yard, and running it forward before anyone sees it.
 *
 * A factory rather than a literal, and the warm-up at the end is the reason it is worth
 * its own module: step zero is three locomotives asleep in a shed, which is a picture of
 * nothing — both for a visitor arriving on the page and for the single frozen frame a
 * reduced-motion visitor gets instead of the animation.
 *
 * Note the direction of the dependency. This imports `step` from `simulation.ts` and
 * `simulation.ts` imports nothing from here, which is what keeps the two from forming a
 * cycle: staging by *running the simulation* rather than by hand-placing trains means the
 * opening picture cannot drift out of agreement with the rules, and it costs one import
 * pointing this way.
 */

import { SIM, YARD } from "./config";
import { createConveyor, createFreight } from "./conveyor";
import { createCrane } from "./crane";
import { buildGraph, findPath } from "./graph";
import { drawItinerary } from "./phases";
import { range, rangeInt, weightedPick, type Rng } from "./rng";
import { RAIL_YARD_SCENE } from "./scene";
import type { RailScene } from "./scene-types";
import { step } from "./simulation";
import type { TrainState, Wagon, WorldState } from "./world-state";

export function createWorld(rng: Rng, scene: RailScene = RAIL_YARD_SCENE): WorldState {
  const graph = buildGraph(scene);
  const belt = scene.structures.find((s) => s.kind === "conveyor");
  const conveyor = createConveyor(
    rng,
    belt?.kind === "conveyor" ? belt.at[0] : 0,
    belt?.kind === "conveyor" ? belt.at[0] + belt.length : 0,
    belt?.kind === "conveyor" ? belt.at[1] : 0,
  );

  const trains: TrainState[] = [];
  for (let index = 0; index < YARD.TRAIN_COUNT; index++) {
    const duty = weightedPick(rng, scene.duties, (candidate) => candidate.weight);
    const itinerary = drawItinerary(rng, duty);
    /*
     * The rake is made once, here, and kept for the life of the world. Wagons used to be
     * pushed onto a train one per 900 ms while it stood at the bay and thrown away when it
     * got home, which is why they appeared and disappeared. A flat wagon is a piece of
     * rolling stock; what comes and goes is what is on it.
     */
    const wagons: Wagon[] = [];
    for (let wagon = 0; wagon < rangeInt(rng, YARD.RAKE_SIZE); wagon++) {
      // Empty, because a rake standing in a shed is empty. The warm-up runs the real
      // simulation, so by the time anyone sees the yard the crane has filled the ones that
      // ought to be full.
      wagons.push({ cargo: null });
    }

    // Every train opens standing in the shed, on the path it will leave by, so its first
    // dispatch is continuous with where it already is.
    const path = findPath(graph, itinerary.stable, itinerary.loadAt);
    if (!path) continue;

    trains.push({
      id: `train-${index}`,
      dutyId: duty.id,
      kind: "yard",
      phase: "idle",
      path,
      distance: 0,
      speed: 0,
      timer: range(rng, YARD.IDLE_MS) + index * YARD.STAGGER_MS,
      handled: 0,
      wagons,
      itinerary,
      blocked: false,
      sinceSmoke: 0,
    });
  }

  /*
   * One express per through working, standing on its own hidden road.
   *
   * Its rake is loaded and stays loaded — an express is freight passing through, so the
   * containers on it belong to somewhere else and the crane never touches them. That is
   * also why they are made here with cargo already on: nothing in the yard would ever put
   * one there.
   */
  scene.expresses.forEach((express, index) => {
    const path = findPath(graph, express.holdAt, express.runTo);
    if (!path) return;

    const wagons: Wagon[] = [];
    for (let wagon = 0; wagon < rangeInt(rng, YARD.RAKE_SIZE); wagon++) {
      wagons.push({ cargo: createFreight(rng) });
    }

    trains.push({
      id: express.id,
      dutyId: express.id,
      kind: "express",
      phase: "waiting",
      path,
      distance: 0,
      speed: 0,
      timer: range(rng, YARD.EXPRESS_GAP_MS) + index * YARD.EXPRESS_STAGGER_MS,
      handled: 0,
      wagons,
      // An express has one stop and it is the one it starts from, so every waypoint on it
      // is either where it holds or where it runs to. Nothing else applies to a working
      // that never enters the yard.
      itinerary: {
        stable: express.holdAt,
        loadAt: express.holdAt,
        unloadAt: express.holdAt,
        enterVia: express.holdAt,
        leaveVia: express.runTo,
      },
      blocked: false,
      sinceSmoke: 0,
    });
  });

  const world: WorldState = {
    graph,
    elapsedMs: 0,
    trains,
    // Parked over the head of the belt: the one place in the crane's reach that is not
    // above a running line, so an idle magnet is never anything a train can drive into.
    crane: createCrane(conveyor.headX, conveyor.y),
    conveyor,
    puffs: [],
    occupancy: { onEdge: new Map(), atNode: new Map() },
  };

  /*
   * Run the real simulation forward before anyone sees it.
   *
   * Staged by running the thing rather than by hand-placing trains into a state it would
   * never produce, which also means the warm-up cannot drift out of agreement with the
   * rules.
   */
  const warmup = Math.round(YARD.WARMUP_MS / SIM.STEP_MS);
  for (let index = 0; index < warmup; index++) step(world, SIM.STEP_MS, rng);
  return world;
}
