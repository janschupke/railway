/**
 * The yard at work: one fixed-timestep tick, and the longitudinal dynamics it runs on.
 *
 * `step` mutates and returns the world. That is a deliberate departure from referential
 * purity: nothing outside the simulation reads a `WorldState` between two steps — React
 * never sees one — so immutability buys no safety, while threading an immutable world
 * through eight phase handlers makes every one of them harder to read.
 *
 * The contract the tests hold it to instead is **determinism**. `step` reads no ambient
 * clock and no ambient randomness: time arrives as `dtMs` and chance as an explicit `Rng`,
 * so a world from a fixed seed advanced by a fixed sequence is identical every run.
 *
 * The other contract, and the one every visible defect in the first version came down to,
 * is that **a train is always somewhere**. It never has a null path, it is never
 * repositioned, and nothing is created or destroyed while anyone could be looking. A train
 * that leaves does so by driving out of the frame on rails that continue; it comes back by
 * driving in. Wagons are made once and kept for the life of the world. Containers ride a
 * belt in from off camera and move between it and a wagon in the jaws of a crane. If
 * something is not visible, it is because it is somewhere else — never because it has
 * stopped existing.
 *
 * What this file no longer holds, and where it went: the shapes are in `world-state.ts`,
 * the phase machine in `phases.ts`, the exhaust in `smoke.ts`, the crane protocol's
 * world-side half in `crane-service.ts`, and the factory in `create-world.ts`. What is
 * left is the loop and the two questions only the loop asks — how fast a train may go, and
 * whether anyone can see it.
 */

import { YARD } from "./config";
import { edgeIndexAt, edgeStart, poseAlong } from "./graph";
import { runCrane } from "./crane-service";
import { stepConveyor } from "./conveyor";
import { COMPLETE, PHASE_KIND, holdExpress, stopFor } from "./phases";
import type { Rng } from "./rng";
import { ageSmoke, emitSmoke } from "./smoke";
import { limitFor, occupancyOf } from "./traffic";
import { trainLength, type TrainState, type WorldState } from "./world-state";

/**
 * Line speed: the limit under the nose, and every slower one ahead approached on a curve.
 *
 * The curve is the same `sqrt(v^2 + 2 a s)` the brake uses everywhere else, which is what
 * makes a train slow *into* a turnout rather than either arriving at it too fast or crawling
 * all the way to it.
 *
 * It crawled. The version this replaces took the minimum of the edge under the nose and the
 * one after it, flat — so a train on the sixteen-hundred-unit run down the main line was
 * held to the speed of a turnout at the far end of it for the whole distance, thirty-seven
 * units a second where the road is rated at eighty-five. Forty-four seconds to cross a
 * frame it should cross in thirteen, and the single biggest reason the yard looked empty:
 * the train was there, and it was barely moving.
 */
function lineSpeed(world: WorldState, train: TrainState): number {
  const { path } = train;
  if (path.edges.length === 0) return 0;

  const index = edgeIndexAt(path, train.distance);
  const here = world.graph.edges.get(path.edges[index]!);
  let limit = YARD.BASE_SPEED * (here?.speed ?? 1);

  for (let next = index + 1; next < path.edges.length; next++) {
    const gap = Math.max(0, edgeStart(path, next) - train.distance);
    /*
     * Nothing further on can lower the answer once the gap alone exceeds what the train
     * could brake through, because the curve is monotonic in `gap` and the slowest an edge
     * can be is a standstill. An exact bound rather than a horizon: a homebound leg is a
     * dozen edges long and this is per train per step.
     */
    if (2 * YARD.BRAKE * gap >= limit * limit) break;
    const edge = world.graph.edges.get(path.edges[next]!);
    if (!edge) continue;
    const ahead = YARD.BASE_SPEED * edge.speed;
    limit = Math.min(limit, Math.sqrt(ahead * ahead + 2 * YARD.BRAKE * gap));
  }
  return limit;
}

/**
 * Whether a train is somewhere a visitor can actually see it, and moving.
 *
 * The measure the traffic is tuned against, so it has to mean what the eye means: on a road
 * that is drawn, inside the frame, and going somewhere. A locomotive doing three hundred
 * units a second down a hidden road is not something to look at.
 */
function isShowing(world: WorldState, train: TrainState): boolean {
  if (train.speed <= 1) return false;
  const pose = poseAlong(world.graph, train.path, train.distance);
  if (!pose || pose.y < 0) return false;
  const { focusX, extent } = world.graph.scene;
  return Math.abs(pose.x - focusX) <= extent.width / 2;
}

/**
 * One fixed-timestep tick.
 *
 * The order inside the loop is the whole of the traffic repair. Occupancy is rebuilt from
 * where the trains are, authority is computed as a pure read, `blocked` is written from it,
 * and only then does the speed code read `blocked` — in the same function, in that order.
 * The previous version wrote the flag after the read and cleared it before the next one, so
 * it never once influenced a brake.
 */
export function step(world: WorldState, dtMs: number, rng: Rng): WorldState {
  world.elapsedMs += dtMs;
  const seconds = dtMs / 1000;

  world.occupancy = occupancyOf(
    world.graph,
    world.trains.map((train) => ({
      id: train.id,
      path: train.path,
      distance: train.distance,
      length: trainLength(train),
      speed: train.speed,
    })),
  );

  /*
   * How much of the yard is in the frame, worked out once. Only a waiting express reads it,
   * and only two of those exist, but it costs two poses per train and both of them would
   * otherwise be paid twice a step for an answer that cannot differ.
   */
  const waiting = world.trains.some(
    (train) => train.kind === "express" && train.phase === "waiting",
  );
  const showing = waiting
    ? world.trains.filter((train) => isShowing(world, train)).length
    : 0;

  for (const train of world.trains) {
    const kind = PHASE_KIND[train.phase];

    if (kind !== "moving") {
      train.speed = 0;
      train.blocked = false;
      holdExpress(train, showing);
      if (train.timer > 0) train.timer = Math.max(0, train.timer - dtMs);
      const ready =
        kind === "timed" ? train.timer <= 0 : train.handled >= train.wagons.length;
      if (ready && train.timer <= 0) COMPLETE[train.phase](world, train, rng);
      continue;
    }

    const authority = limitFor(
      world.graph,
      world.occupancy,
      {
        id: train.id,
        path: train.path,
        distance: train.distance,
        length: trainLength(train),
        speed: train.speed,
      },
      stopFor(train),
    );

    /*
     * One braking curve, applied to the gap, whatever produced it.
     *
     * `sqrt(2 a s)` is the fastest a train may be going and still stop in the distance it
     * has — so as the gap closes the ceiling falls to zero and the train arrives at rest.
     * A signal, a queue and a station stop all decelerate identically, because none of them
     * is anything more than a number here.
     *
     * The version this replaces decided to brake with `gap <= v^2/2a` and then, when that
     * discrete test let it overshoot, assigned the speed it had *achieved* — which from
     * line speed is a jump straight to zero in one 20 ms step. That was the invisible wall.
     */
    const gap = Math.max(0, authority.limit - train.distance);
    const line = lineSpeed(world, train);
    const ceiling = Math.sqrt(2 * YARD.BRAKE * gap);
    train.blocked = authority.reason !== "clear" && ceiling < line;

    const target = Math.min(line, ceiling);
    const rate = target > train.speed ? YARD.ACCEL : YARD.BRAKE;
    train.speed = Math.max(
      0,
      train.speed + clampTo(target - train.speed, rate * seconds),
    );

    /*
     * Nothing clamps the movement. The curve is the brake, and a clamp on top of it is what
     * the old model used *instead* of one — which is exactly how a train came to shed line
     * speed in a single step. `JUNCTION_LOOKAHEAD` is set wide enough that a train always
     * sees an authority in time to stop against it, so the clamp has nothing left to do.
     */
    const moved = train.speed * seconds;
    train.distance += moved;
    train.sinceSmoke += moved;

    emitSmoke(world, train, rng);

    const stop = stopFor(train);
    if (train.distance >= stop) {
      train.distance = stop;
      COMPLETE[train.phase](world, train, rng);
    }
  }

  runCrane(world, dtMs);
  stepConveyor(world.conveyor, dtMs, rng);
  ageSmoke(world, dtMs);
  return world;
}

const clampTo = (value: number, magnitude: number): number =>
  value < -magnitude ? -magnitude : value > magnitude ? magnitude : value;
