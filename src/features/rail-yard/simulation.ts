/**
 * The yard at work.
 *
 * `step` mutates and returns the world. That is a deliberate departure from referential
 * purity: nothing outside the simulation reads a `WorldState` between two steps — React
 * never sees one — so immutability buys no safety, while threading an immutable world
 * through eight phase handlers makes every one of them harder to read.
 *
 * The contract the tests hold it to instead is **determinism**. `step` reads no ambient
 * clock and no ambient randomness: time arrives as `dtMs` and chance as an explicit `Rng`,
 * so a world from a fixed seed advanced by a fixed sequence is identical every run.
 * `snapshot` exists for exactly those assertions.
 *
 * The other contract, and the one every visible defect in the first version came down to,
 * is that **a train is always somewhere**. It never has a null path, it is never
 * repositioned, and nothing is created or destroyed while anyone could be looking. A train
 * that leaves does so by driving out of the frame on rails that continue; it comes back by
 * driving in. Wagons are made once and kept for the life of the world. Containers ride a
 * belt in from off camera and move between it and a wagon in the jaws of a crane. If
 * something is not visible, it is because it is somewhere else — never because it has
 * stopped existing.
 */

import { LOCOMOTIVE, SIM, WAGON, YARD } from "./config";
import { localToWorld, type Pose } from "./geometry";
import {
  buildGraph,
  edgeIndexAt,
  edgeStart,
  findPath,
  poseAlong,
  type Path,
  type RailGraph,
} from "./graph";
import { FREIGHT_TOKENS } from "./palette";
import { pick, range, rangeInt, weightedPick, type Rng } from "./rng";
import { RAIL_YARD_SCENE, type Duty, type RailScene } from "./scene";
import {
  assignCrane,
  createCrane,
  releaseCrane,
  stepCrane,
  wagonNoseDistance,
  type CraneState,
} from "./crane";
import {
  createConveyor,
  headClear,
  headLoaded,
  putOnBelt,
  stepConveyor,
  takeFromBelt,
  type Conveyor,
} from "./conveyor";
import { limitFor, occupancyOf, type Occupancy } from "./traffic";

/**
 * Two rings, not one.
 *
 * The first eight phases are a yard train's working day. The last three are an express's,
 * and it is a *train* rather than a duty for a reason: a through working that had to be
 * expressed as a duty would need a stop it does not make and a crane it does not use, and
 * every phase handler would grow a branch for the case where none of that applies.
 */
export type TrainPhase =
  | "idle"
  | "outbound"
  | "loading"
  | "hauling"
  | "away"
  | "inbound"
  | "unloading"
  | "homebound"
  | "waiting"
  | "running"
  | "returning";

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
const PHASE_KIND: Readonly<Record<TrainPhase, "timed" | "working" | "moving">> = {
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

type Wagon = {
  /** Index into FREIGHT_TOKENS, or null for an empty flat. Never a colour string. */
  cargo: number | null;
  readonly ribs: number;
};

type Itinerary = {
  readonly stable: string;
  readonly loadAt: string;
  readonly unloadAt: string;
  readonly leaveVia: string;
  readonly enterVia: string;
};

export type TrainState = {
  readonly id: string;
  readonly dutyId: string;
  /** Which ring this train goes round. The crane only ever looks at yard trains. */
  readonly kind: "yard" | "express";
  phase: TrainPhase;
  /** Never null. A train that cannot be seen is off-camera, not absent. */
  path: Path;
  distance: number;
  speed: number;
  timer: number;
  /** Containers the crane has finished with this visit. */
  handled: number;
  wagons: Wagon[];
  itinerary: Itinerary;
  blocked: boolean;
  sinceSmoke: number;
};

type Puff = {
  x: number;
  y: number;
  /** Height. Smoke rises in z — adding it to depth would push it into the scene. */
  z: number;
  driftX: number;
  ageMs: number;
  readonly lifeMs: number;
};

export type WorldState = {
  readonly graph: RailGraph;
  elapsedMs: number;
  trains: TrainState[];
  crane: CraneState;
  conveyor: Conveyor;
  puffs: Puff[];
  occupancy: Occupancy;
};

export function trainLength(train: TrainState): number {
  return (
    LOCOMOTIVE.length +
    train.wagons.length * (WAGON.length + YARD.WAGON_GAP) +
    (train.wagons.length > 0 ? YARD.WAGON_GAP : 0)
  );
}

/** The stop a phase runs to, or Infinity for a leg that carries on off the side. */
function stopFor(train: TrainState): number {
  return PHASE_KIND[train.phase] === "moving" ? train.path.length : Infinity;
}

function drawItinerary(rng: Rng, duty: Duty): Itinerary {
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

const COMPLETE: Readonly<
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
function holdExpress(train: TrainState, showing: number): void {
  if (train.kind !== "express" || train.phase !== "waiting") return;
  if (showing <= 1) train.timer = Math.min(train.timer, YARD.EXPRESS_URGENT_MS);
}

function dutyOf(world: WorldState, train: TrainState): Duty {
  return (
    world.graph.scene.duties.find((duty) => duty.id === train.dutyId) ??
    world.graph.scene.duties[0]
  );
}

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

/** Where the locomotive's chimney is, in the world. Rotated, and rising in z. */
function chimneyAt(world: WorldState, train: TrainState): Pose & { z: number } {
  const nose = poseAlong(world.graph, train.path, train.distance);
  const chimney = LOCOMOTIVE.chimney!;
  if (!nose) return { x: 0, y: 0, angle: 0, z: chimney.top };
  const [x, y] = localToWorld(nose, chimney.at - LOCOMOTIVE.length, 0);
  return { x, y, angle: nose.angle, z: chimney.top };
}

function emitSmoke(world: WorldState, train: TrainState, rng: Rng): void {
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

function ageSmoke(world: WorldState, dtMs: number): void {
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

/**
 * The crane's target, which only the simulation can work out: where the wagon it is meant
 * to be serving actually is, on the ground, right now.
 */
function craneTarget(world: WorldState) {
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

function runCrane(world: WorldState, dtMs: number): void {
  const { conveyor, crane } = world;

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

/**
 * How many fixed steps a frame's delta is worth, and what is left over.
 *
 * The remainder becomes the renderer's interpolation alpha, so the simulation stays on its
 * fixed grid while a 120 Hz display still gets smooth motion. The clamp is the
 * spiral-of-death guard: a tab that wakes after four seconds must not run two hundred steps
 * on the frame it wakes on, which is a visible freeze followed by every train teleporting.
 * The excess is dropped rather than repaid — nobody was watching.
 */
export function stepsFor(
  accumulator: number,
  deltaMs: number,
): { steps: number; rest: number } {
  const total = accumulator + Math.max(0, Math.min(deltaMs, SIM.MAX_CATCHUP_MS));
  const steps = Math.floor(total / SIM.STEP_MS);
  return { steps, rest: total - steps * SIM.STEP_MS };
}

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
      wagons.push({ cargo: null, ribs: rangeInt(rng, [5, 8]) });
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
      wagons.push({
        cargo: Math.floor(rng() * FREIGHT_TOKENS.length),
        ribs: rangeInt(rng, [5, 8]),
      });
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
   * Step zero is three locomotives asleep in a shed, which is a picture of nothing — both
   * for a visitor arriving on the page and for the single frozen frame a reduced-motion
   * visitor gets instead of the animation. Staged by running the thing rather than by
   * hand-placing trains into a state it would never produce, which also means the warm-up
   * cannot drift out of agreement with the rules.
   */
  const warmup = Math.round(YARD.WARMUP_MS / SIM.STEP_MS);
  for (let index = 0; index < warmup; index++) step(world, SIM.STEP_MS, rng);
  return world;
}

/** A JSON-safe deep copy, for the determinism assertions. The graph is scene data. */
export function snapshot(world: WorldState): unknown {
  return {
    elapsedMs: world.elapsedMs,
    puffs: world.puffs.map((puff) => ({ ...puff })),
    crane: { ...world.crane },
    conveyor: {
      ...world.conveyor,
      boxes: world.conveyor.boxes.map((box) => ({ ...box })),
    },
    trains: world.trains.map((train) => ({
      ...train,
      wagons: train.wagons.map((wagon) => ({ ...wagon })),
      itinerary: { ...train.itinerary },
      path: {
        ...train.path,
        edges: [...train.path.edges],
        marks: [...train.path.marks],
      },
    })),
  };
}
