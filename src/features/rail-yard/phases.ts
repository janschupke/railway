/**
 * A train's working day as a state machine: what each phase is waiting for, and what it
 * does when the wait is over.
 *
 * Eleven handlers and the seven helpers they route with, lifted out of `simulation.ts` —
 * where they sat between the type declarations and the tick loop, so the file answered
 * three unrelated questions and the machine could only be read by scrolling past both.
 * Nothing here advances time. The loop decides *when* a phase is complete; this decides
 * what completing it means.
 */

import { YARD } from "./config";
import { findPath, type Path } from "./graph";
import { releaseCrane } from "./crane";
import { pick, range, type Rng } from "./rng";
import type { Duty } from "./scene";
import type { Itinerary, TrainPhase, TrainState, WorldState } from "./world-state";

/** The ring each kind of train goes round, in order. Exported for the lifecycle test. */
export const YARD_RING: readonly TrainPhase[] = [
  "idle",
  "outbound",
  "loading",
  "hauling",
  "away",
  "inbound",
  "unloading",
  "homebound",
];

export const EXPRESS_RING: readonly TrainPhase[] = ["waiting", "running", "returning"];

/**
 * How a phase ends.
 *
 * `timed` waits out a clock, `working` waits for the crane, `moving` waits to arrive. The
 * three are separated because they were not: the first version treated loading as a timer,
 * which is why containers appeared on a schedule rather than when something put them there.
 */
export const PHASE_KIND: Readonly<Record<TrainPhase, "timed" | "working" | "moving">> =
  {
    idle: "timed",
    outbound: "moving",
    loading: "working",
    hauling: "moving",
    away: "timed",
    inbound: "moving",
    unloading: "working",
    homebound: "moving",
    waiting: "timed",
    running: "moving",
    returning: "moving",
  };

/** The stop a phase runs to, or Infinity for a leg that carries on off the side. */
export function stopFor(train: TrainState): number {
  return PHASE_KIND[train.phase] === "moving" ? train.path.length : Infinity;
}

export function drawItinerary(rng: Rng, duty: Duty): Itinerary {
  return {
    stable: pick(rng, duty.stable),
    loadAt: pick(rng, duty.loadAt),
    unloadAt: pick(rng, duty.unloadAt),
    leaveVia: pick(rng, duty.leaveVia),
    enterVia: pick(rng, duty.enterVia),
  };
}

/**
 * Where the train is standing now, as a node id, so the next leg can start from it.
 *
 * Read from `distance`, not from the path's end. A train that has arrived is at the far end
 * of its path; one that has not yet set off — which is every train on the frame the world is
 * created — is at the near end. Taking the end unconditionally made a newly built train
 * believe it was already at the loading road, so it routed from there to there, got an
 * empty path, and completed every phase on the frame it entered it.
 */
function whereItStands(world: WorldState, train: TrainState): string | null {
  const { edges } = train.path;
  if (edges.length === 0) return null;
  if (train.distance >= train.path.length) {
    return world.graph.edges.get(edges[edges.length - 1]!)?.to ?? null;
  }
  return world.graph.edges.get(edges[0]!)?.from ?? null;
}

/**
 * Sends a train off on a new leg.
 *
 * The one place a path is ever replaced, and it deliberately does *not* touch the train's
 * pose: the new path begins at the node the train is already standing on, so distance zero
 * is the same point in the world as the old path's end. Its rake trails behind at negative
 * distances, which the geometry extrapolates onto the rails behind rather than piling onto
 * the first node — that pile was what made every departure look like a concertina.
 */
function depart(train: TrainState, path: Path, phase: TrainPhase): void {
  train.path = path;
  train.distance = 0;
  train.phase = phase;
}

/** Nothing to do and nowhere to go: wait, and try again. Never a silent stall. */
function retry(train: TrainState): void {
  train.timer = YARD.BLOCKED_RETRY_MS;
  train.speed = 0;
}

function routeFrom(world: WorldState, train: TrainState, to: string): Path | null {
  const from = whereItStands(world, train);
  return from === null ? null : findPath(world.graph, from, to);
}

export const COMPLETE: Readonly<
  Record<TrainPhase, (world: WorldState, train: TrainState, rng: Rng) => void>
> = {
  idle: (world, train, rng) => {
    // A fresh itinerary each dispatch, but the same shed — a locomotive lives somewhere.
    train.itinerary = {
      ...drawItinerary(rng, dutyOf(world, train)),
      stable: train.itinerary.stable,
    };
    const path = routeFrom(world, train, train.itinerary.loadAt);
    if (!path) return retry(train);
    depart(train, path, "outbound");
  },

  outbound: (_world, train) => {
    train.speed = 0;
    train.handled = 0;
    train.phase = "loading";
  },

  loading: (world, train) => {
    releaseCrane(world.crane);
    const path = routeFrom(world, train, train.itinerary.leaveVia);
    if (!path) return retry(train);
    depart(train, path, "hauling");
  },

  hauling: (world, train, rng) => {
    // Off the side of the world, on rails that continue. Nothing is nulled and nothing is
    // moved: the train stands at the staging node, which no camera this page can produce
    // reaches, and waits there like a train waits in a loop.
    train.speed = 0;
    train.phase = "away";
    train.timer = range(rng, YARD.AWAY_MS);
  },

  away: (world, train) => {
    const path = routeFrom(world, train, train.itinerary.unloadAt);
    if (!path) return retry(train);
    depart(train, path, "inbound");
  },

  inbound: (_world, train) => {
    train.speed = 0;
    train.handled = 0;
    train.phase = "unloading";
  },

  unloading: (world, train) => {
    releaseCrane(world.crane);
    const path = routeFrom(world, train, train.itinerary.stable);
    if (!path) return retry(train);
    depart(train, path, "homebound");
  },

  /*
   * The express's ring. It waits on hidden track, runs the length of its road, and comes
   * back round the way it came — no stop, no crane, and nothing to arbitrate but traffic.
   */
  waiting: (world, train) => {
    const path = routeFrom(world, train, train.itinerary.leaveVia);
    if (!path) return retry(train);
    depart(train, path, "running");
  },

  running: (world, train) => {
    const path = routeFrom(world, train, train.itinerary.enterVia);
    if (!path) return retry(train);
    depart(train, path, "returning");
  },

  returning: (_world, train, rng) => {
    train.speed = 0;
    train.phase = "waiting";
    train.timer = range(rng, YARD.EXPRESS_GAP_MS);
  },

  homebound: (world, train, rng) => {
    /*
     * Home, and standing in the shed rather than back where it started.
     *
     * `distance` deliberately keeps the value it arrived on. The first version reset it to
     * zero without replacing the path, so an idling train was rendered at the *start* of
     * its homebound route — in the middle of the yard — for the whole dwell, and then
     * jumped to the shed the instant it was dispatched. Two teleports a cycle, both in
     * plain view, and the most obvious thing wrong with the picture.
     */
    train.speed = 0;
    train.phase = "idle";
    train.timer = range(rng, YARD.IDLE_MS);
  },
};

/**
 * An express standing between runs, and the one thing that can cut its wait short.
 *
 * The wait is drawn from a band when the run ends — random, so two runs never look like a
 * metronome — and that is the whole of the pacing while the yard is working. But a gap drawn
 * during a busy minute outlives the minute: it was twenty-one seconds once, and the yard
 * fell quiet eight seconds into it. So the ceiling is applied every step rather than at the
 * draw, which is the difference between "the express is sooner when the yard is quiet" and
 * "the express was going to be sooner, back when it was decided".
 *
 * It counts what is *showing*, not what is moving, because a train doing three hundred units
 * a second down a hidden road is not something the frame has in it. The count is taken once
 * for the whole step and handed in: working it out per waiting express meant two poses per
 * train per express per step, which is the most expensive thing in the loop asked for twice.
 */
export function holdExpress(train: TrainState, showing: number): void {
  if (train.kind !== "express" || train.phase !== "waiting") return;
  if (showing <= 1) train.timer = Math.min(train.timer, YARD.EXPRESS_URGENT_MS);
}

function dutyOf(world: WorldState, train: TrainState): Duty {
  return (
    world.graph.scene.duties.find((duty) => duty.id === train.dutyId) ??
    world.graph.scene.duties[0]!
  );
}
