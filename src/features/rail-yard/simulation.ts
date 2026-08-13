/**
 * The yard's state machine.
 *
 * `step` mutates the world it is given and returns it. That is a deliberate departure
 * from referential purity, and worth stating plainly: nothing outside this module ever
 * reads a `WorldState` between two steps — React never sees one — so immutability buys
 * no safety here, while threading a fresh world through eight phase handlers makes every
 * one of them harder to read.
 *
 * The contract that *is* enforced is determinism. `step` reads no ambient clock and no
 * ambient randomness: time arrives as `dtMs` and chance arrives as `rng`.
 * simulation.test.ts holds it to that by making `Math.random` and `Date.now` throw for
 * the length of a run, and by advancing two worlds from one seed and comparing snapshots.
 */

import { clamp, type Pose } from "./geometry";
import { LOCOMOTIVE, SIM, WAGON, YARD } from "./config";
import {
  buildGraph,
  edgeIndexAt,
  findPath,
  poseAlong,
  type Path,
  type RailGraph,
} from "./graph";
import { FREIGHT_TOKENS } from "./palette";
import { pick, range, rangeInt, weightedPick, type Rng } from "./rng";
import { RAIL_YARD_SCENE, type Duty, type RailScene } from "./scene";

export type TrainPhase =
  | "idle" // parked in a depot, counting down
  | "outbound" // depot → bay, empty
  | "loading" // stationary at the bay, coupling one container at a time
  | "hauling" // bay → exit, loaded
  | "away" // past the exit, off camera, counting down
  | "inbound" // entry → bay, loaded from somewhere else
  | "unloading" // stationary, uncoupling one at a time
  | "homebound"; // bay → depot, empty

type Wagon = {
  /** Index into FREIGHT_TOKENS, or null on a flat wagon. */
  cargo: number | null;
  /** Corrugation count. Fixed for the wagon's life so the box does not shimmer. */
  readonly ribs: number;
};

type Puff = {
  x: number;
  y: number;
  readonly driftX: number;
  readonly driftY: number;
  ageMs: number;
  readonly lifeMs: number;
};

type Itinerary = {
  readonly home: string;
  readonly bay: string;
  readonly exit: string;
  readonly entry: string;
};

export type TrainState = {
  readonly id: string;
  dutyId: string;
  phase: TrainPhase;
  /** null only while `away`. Otherwise it positions the train even when stationary. */
  path: Path | null;
  /** Arc length of the locomotive's nose along `path`. */
  distance: number;
  /** World units per second. Eased toward a target, never snapped. */
  speed: number;
  /** Countdown, ms. The only clock any timed phase has. */
  timer: number;
  /** Wagons coupled or uncoupled so far in the current loading or unloading. */
  handled: number;
  /** How many wagons this working runs with. */
  target: number;
  wagons: Wagon[];
  itinerary: Itinerary;
  /** Held by another train's claim. Also what turns a signal red in the renderer. */
  blocked: boolean;
  /** Edge ids this train currently claims. */
  held: string[];
  /** The stopping place it has reserved, if any. See `claimNode`. */
  heldNode: string | null;
  /** Travel since the last puff, so a stationary locomotive stops smoking. */
  sinceSmoke: number;
};

export type WorldState = {
  readonly graph: RailGraph;
  elapsedMs: number;
  trains: TrainState[];
  /**
   * The only shared resource in the simulation: `edge id → train id` for track, and
   * `node:<id> → train id` for a stopping place.
   *
   * Track alone is not enough. Two workings terminate at the same bay from different
   * directions — outbound over the depot road, inbound off the main line — on paths that
   * share no edge at all, so an edge-only rule let one train park inside another. The
   * node claim is what a platform road actually is.
   */
  occupancy: Map<string, string>;
  puffs: Puff[];
};

const nodeKey = (id: string): string => `node:${id}`;

/** Locomotive plus rake, world units. Drives occupancy and the exit test. */
export function trainLength(train: TrainState): number {
  return LOCOMOTIVE.length + train.wagons.length * (WAGON.length + YARD.WAGON_GAP);
}

function chooseItinerary(duty: Duty, rng: Rng): Itinerary {
  return {
    home: pick(rng, duty.home),
    bay: pick(rng, duty.loadAt),
    exit: pick(rng, duty.exitVia),
    entry: pick(rng, duty.enterVia),
  };
}

function makeWagon(rng: Rng, loaded: boolean): Wagon {
  return {
    cargo: loaded ? Math.floor(rng() * FREIGHT_TOKENS.length) : null,
    ribs: rangeInt(rng, [5, 8]),
  };
}

/** The scene's duty for a train, or the first one if the config changed underneath it. */
function dutyOf(world: WorldState, train: TrainState): Duty {
  const duties = world.graph.scene.duties;
  return duties.find((duty) => duty.id === train.dutyId) ?? duties[0];
}

/**
 * Where the current phase ends, in path distance, and whether the train stops there.
 *
 * `hauling` is the one working that does not stop: it ends when the *last wagon* has
 * cleared the exit, not when the nose reaches it — otherwise the rake vanishes while
 * half of it is still on camera.
 */
function endOfPhase(train: TrainState): { at: number; stops: boolean } | null {
  const length = train.path?.length ?? 0;
  switch (train.phase) {
    case "outbound":
    case "inbound":
    case "homebound":
      return { at: length, stops: true };
    case "hauling":
      return { at: length + trainLength(train), stops: false };
    default:
      return null;
  }
}

/** The node a moving train is heading for, or null if this phase does not stop. */
function destinationOf(train: TrainState): string | null {
  switch (train.phase) {
    case "outbound":
    case "inbound":
      return train.itinerary.bay;
    case "homebound":
      return train.itinerary.home;
    default:
      return null;
  }
}

function claimNode(world: WorldState, train: TrainState, id: string): boolean {
  const holder = world.occupancy.get(nodeKey(id));
  if (holder !== undefined && holder !== train.id) return false;
  world.occupancy.set(nodeKey(id), train.id);
  train.heldNode = id;
  return true;
}

function releaseNode(world: WorldState, train: TrainState): void {
  if (train.heldNode === null) return;
  if (world.occupancy.get(nodeKey(train.heldNode)) === train.id) {
    world.occupancy.delete(nodeKey(train.heldNode));
  }
  train.heldNode = null;
}

/**
 * Claims and releases track.
 *
 * A train occupies every edge its body spans, nose to rear coupling. It may advance into
 * the next edge only if nobody else holds it; if someone does, the nose stops at the
 * boundary — which is where a signal would be — and `blocked` goes up, which is also
 * what turns that signal red in the renderer.
 *
 * Only edges *ahead* of where the nose already is are ever contested. The edge under the
 * train is its own by definition, and checking it too is how the first version wedged:
 * a corrupted map made a train find its own road held by someone else, clamp its allowed
 * distance to zero, and stand there for the rest of the run.
 *
 * Returns the distance the train is actually allowed to reach.
 */
function reserve(world: WorldState, train: TrainState, wanted: number): number {
  const path = train.path;
  if (!path || path.edges.length === 0) return wanted;

  const noseIndex = edgeIndexAt(path, clamp(train.distance, 0, path.length));
  const wantedIndex = edgeIndexAt(path, clamp(wanted, 0, path.length));
  let allowed = wanted;
  let front = wantedIndex;

  for (let index = noseIndex + 1; index <= wantedIndex; index++) {
    const id = path.edges[index]!;
    const holder = world.occupancy.get(id);
    if (holder === undefined || holder === train.id) continue;
    // `index` is at least one here, so there is always a preceding mark to clamp to.
    allowed = path.marks[index - 1]!;
    front = index - 1;
    train.blocked = true;
    break;
  }

  /*
   * Claim the span, and never take an edge another train holds. Overwriting was the
   * other half of the wedge above — three trains each believed they held the depot road
   * because the last writer won, and all three then blocked on it.
   */
  const claimed = new Set<string>();
  const rear = edgeIndexAt(path, Math.max(0, allowed - trainLength(train)));
  for (let index = rear; index <= front; index++) {
    const id = path.edges[index]!;
    const holder = world.occupancy.get(id);
    if (holder !== undefined && holder !== train.id) continue;
    claimed.add(id);
  }

  for (const id of train.held) {
    if (!claimed.has(id) && world.occupancy.get(id) === train.id) {
      world.occupancy.delete(id);
    }
  }
  for (const id of claimed) world.occupancy.set(id, train.id);
  train.held = [...claimed];

  return allowed;
}

/**
 * Whether a train may take the first edge of a path it is about to adopt.
 *
 * Every departure starts at distance zero, which `reserve` treats as already-mine — so
 * without this gate three trains could dispatch onto the same depot road in the same
 * second and each believe the road was theirs.
 */
function roadIsClear(world: WorldState, train: TrainState, path: Path): boolean {
  const first = path.edges[0];
  if (first === undefined) return true;
  const holder = world.occupancy.get(first);
  return holder === undefined || holder === train.id;
}

/**
 * Puts a train onto a new path at its start, taking the first edge in the same breath.
 *
 * Claiming here rather than leaving it to the next `advance` matters: trains are stepped
 * in order, so a later one could otherwise pass `roadIsClear` in the same step, before
 * the earlier one had claimed anything.
 */
function depart(
  world: WorldState,
  train: TrainState,
  path: Path,
  phase: TrainPhase,
): void {
  releaseTrack(world, train);
  train.path = path;
  train.distance = 0;
  train.phase = phase;
  const first = path.edges[0];
  if (first !== undefined) {
    world.occupancy.set(first, train.id);
    train.held = [first];
  }
}

function releaseTrack(world: WorldState, train: TrainState): void {
  for (const id of train.held) {
    if (world.occupancy.get(id) === train.id) world.occupancy.delete(id);
  }
  train.held = [];
}

/** Puts a train back in its depot with a retry timer. The only recovery path there is. */
function stall(world: WorldState, train: TrainState, rng: Rng): void {
  releaseTrack(world, train);
  train.phase = "idle";
  train.speed = 0;
  train.distance = 0;
  train.timer = range(rng, YARD.IDLE_MS);
}

/**
 * What each phase does when it finishes.
 *
 * One entry per phase, so the cycle reads as a list rather than having to be
 * reconstructed from a long switch.
 */
const COMPLETE: Record<
  TrainPhase,
  (world: WorldState, train: TrainState, rng: Rng) => void
> = {
  idle: (world, train, rng) => {
    const duty = dutyOf(world, train);
    // The depot it is standing in is not up for reselection; everything else is.
    const itinerary = { ...chooseItinerary(duty, rng), home: train.itinerary.home };
    const path = findPath(world.graph, itinerary.home, itinerary.bay);
    if (!path) return stall(world, train, rng);
    if (!roadIsClear(world, train, path)) {
      train.timer = YARD.BLOCKED_RETRY_MS;
      return;
    }
    train.itinerary = itinerary;
    train.target = rangeInt(rng, duty.wagons);
    depart(world, train, path, "outbound");
  },

  outbound: (_world, train) => {
    train.phase = "loading";
    train.handled = 0;
    train.speed = 0;
    train.timer = YARD.COUPLE_MS;
  },

  /*
   * One wagon per COUPLE_MS, re-arming until the rake is made up. That is what makes the
   * loading read as work happening rather than as a rake appearing.
   */
  loading: (world, train, rng) => {
    if (train.handled < train.target) {
      train.wagons.push(makeWagon(rng, true));
      train.handled += 1;
      train.timer = YARD.COUPLE_MS;
      return;
    }
    const path = findPath(world.graph, train.itinerary.bay, train.itinerary.exit);
    if (!path) return stall(world, train, rng);
    if (!roadIsClear(world, train, path)) {
      train.timer = YARD.BLOCKED_RETRY_MS;
      return;
    }
    releaseNode(world, train);
    depart(world, train, path, "hauling");
  },

  hauling: (world, train, rng) => {
    releaseTrack(world, train);
    train.phase = "away";
    train.path = null;
    train.speed = 0;
    train.timer = range(rng, YARD.AWAY_MS);
  },

  /*
   * A train comes back as a different working: fresh itinerary, fresh cargo. If the
   * entry road is held it waits off camera rather than materialising on top of whoever
   * holds it, which is the one place a re-entry could otherwise telefrag.
   */
  away: (world, train, rng) => {
    const duty = dutyOf(world, train);
    const itinerary = chooseItinerary(duty, rng);
    const path = findPath(world.graph, itinerary.entry, itinerary.bay);
    if (!path || !roadIsClear(world, train, path)) {
      train.timer = YARD.BLOCKED_RETRY_MS;
      return;
    }
    train.itinerary = itinerary;
    train.target = rangeInt(rng, duty.wagons);
    train.wagons = Array.from({ length: train.target }, () => makeWagon(rng, true));
    depart(world, train, path, "inbound");
  },

  inbound: (_world, train) => {
    train.phase = "unloading";
    train.handled = 0;
    train.speed = 0;
    train.timer = YARD.COUPLE_MS;
  },

  /*
   * Uncoupling empties a wagon rather than removing it. A rake returning to the depot
   * with its flats still on is what makes the homebound train read as the one that
   * arrived loaded, rather than as a locomotive that lost its consist.
   */
  unloading: (world, train, rng) => {
    const laden = train.wagons.filter((wagon) => wagon.cargo !== null);
    const last = laden[laden.length - 1];
    if (last) {
      last.cargo = null;
      train.handled += 1;
      train.timer = YARD.COUPLE_MS;
      return;
    }
    const path = findPath(world.graph, train.itinerary.bay, train.itinerary.home);
    if (!path) return stall(world, train, rng);
    if (!roadIsClear(world, train, path)) {
      train.timer = YARD.BLOCKED_RETRY_MS;
      return;
    }
    releaseNode(world, train);
    depart(world, train, path, "homebound");
  },

  homebound: (world, train, rng) => {
    releaseTrack(world, train);
    train.wagons = [];
    train.phase = "idle";
    train.speed = 0;
    train.distance = 0;
    train.timer = range(rng, YARD.IDLE_MS);
  },
};

/** The speed the edge under the locomotive allows, in world units per second. */
function lineSpeed(world: WorldState, train: TrainState): number {
  const path = train.path;
  if (!path || path.edges.length === 0) return 0;
  const id = path.edges[edgeIndexAt(path, train.distance)]!;
  return YARD.BASE_SPEED * (world.graph.edges.get(id)?.speed ?? 1);
}

function advance(world: WorldState, train: TrainState, dtMs: number): void {
  const end = endOfPhase(train);
  const path = train.path;
  if (!end || !path) return;

  const destination = destinationOf(train);
  // Let go of the platform it started from once it is clear of it.
  if (train.heldNode !== null && train.heldNode !== destination) {
    if (train.distance > YARD.HEADWAY) releaseNode(world, train);
  }

  const seconds = dtMs / 1000;
  let limit = end.at;

  /*
   * Reserve the stopping place before arriving at it, not on arrival. A train that
   * cannot have the bay waits on the approach — which is what a signal at the throat is
   * for — rather than coming to a stand on top of whoever is already there.
   */
  if (destination !== null && train.heldNode !== destination) {
    const remaining = end.at - train.distance;
    if (remaining <= YARD.HEADWAY * 2 && !claimNode(world, train, destination)) {
      limit = Math.max(0, end.at - YARD.HEADWAY);
      train.blocked = true;
    }
  }

  /*
   * Brake early enough to arrive at a stand rather than stopping dead on the frame the
   * distance runs out. v² / 2a is the textbook stopping distance, and it is what makes a
   * train ease into the loading bay instead of hitting it.
   */
  const brakingDistance = (train.speed * train.speed) / (2 * YARD.BRAKE);
  const stopping = end.stops && limit - train.distance <= brakingDistance;
  const target = train.blocked || stopping ? 0 : lineSpeed(world, train);

  const rate = target > train.speed ? YARD.ACCEL : YARD.BRAKE;
  const change = clamp(target - train.speed, -rate * seconds, rate * seconds);
  train.speed = Math.max(0, train.speed + change);

  const travelled = train.speed * seconds;
  const reached = reserve(world, train, train.distance + travelled);
  const moved = Math.max(0, Math.min(reached, limit) - train.distance);
  train.distance += moved;
  train.sinceSmoke += moved;

  /*
   * Speed is a consequence of how far the train actually got. Without this a train held
   * at a red keeps its notional speed and lurches a full step forward the instant the
   * edge clears.
   */
  if (moved < travelled) train.speed = seconds > 0 ? moved / seconds : 0;
}

/** The chimney's world position, derived from the sprite rather than guessed. */
function chimneyAt(world: WorldState, train: TrainState): Pose | null {
  const chimney = LOCOMOTIVE.chimney;
  if (!chimney || !train.path) return null;
  const nose = poseAlong(world.graph, train.path, train.distance);
  if (!nose) return null;
  // Local x runs forward from the rear coupling, so the offset from the nose is negative.
  const back = LOCOMOTIVE.length - chimney.at;
  return {
    x: nose.x - Math.cos(nose.angle) * back,
    y: nose.y - Math.sin(nose.angle) * back + chimney.base + chimney.height,
    angle: nose.angle,
  };
}

function emitSmoke(world: WorldState, train: TrainState, rng: Rng): void {
  if (train.sinceSmoke < YARD.SMOKE_INTERVAL_UNITS) return;
  train.sinceSmoke = 0;
  // A hard ceiling rather than evicting the oldest: a puff that vanishes mid-life reads
  // worse than one that was never emitted, and this bounds the per-frame draw count.
  if (world.puffs.length >= YARD.MAX_PUFFS) return;

  const origin = chimneyAt(world, train);
  if (!origin) return;

  world.puffs.push({
    x: origin.x,
    y: origin.y,
    driftX: YARD.SMOKE_DRIFT * (0.5 + rng()),
    driftY: YARD.SMOKE_RISE * (0.7 + rng() * 0.6),
    ageMs: 0,
    lifeMs: YARD.SMOKE_LIFE_MS,
  });
}

function ageSmoke(world: WorldState, dtMs: number): void {
  const seconds = dtMs / 1000;
  const alive: Puff[] = [];
  for (const puff of world.puffs) {
    puff.ageMs += dtMs;
    if (puff.ageMs >= puff.lifeMs) continue;
    puff.x += puff.driftX * seconds;
    puff.y += puff.driftY * seconds;
    alive.push(puff);
  }
  world.puffs = alive;
}

/**
 * One fixed step.
 *
 * Claim order is `trains` array order, fixed at creation — which is what makes contention
 * between two trains for the same edge resolve the same way on every run.
 */
export function step(world: WorldState, dtMs: number, rng: Rng): WorldState {
  world.elapsedMs += dtMs;

  for (const train of world.trains) {
    train.blocked = false;
    if (train.timer > 0) train.timer = Math.max(0, train.timer - dtMs);

    const end = endOfPhase(train);
    if (end === null) {
      // A timed phase — idle, loading, away, unloading. It ends when its clock runs out.
      if (train.timer <= 0) COMPLETE[train.phase](world, train, rng);
      continue;
    }

    advance(world, train, dtMs);
    emitSmoke(world, train, rng);

    if (train.distance >= end.at) COMPLETE[train.phase](world, train, rng);
  }

  ageSmoke(world, dtMs);
  return world;
}

/**
 * Creates a yard already at work.
 *
 * The warm-up is not decoration: see YARD.WARMUP_MS. It runs the real simulation forward
 * rather than hand-placing trains, so the opening state is one the state machine could
 * actually have reached.
 */
export function createWorld(rng: Rng, scene: RailScene = RAIL_YARD_SCENE): WorldState {
  const graph = buildGraph(scene);
  const trains: TrainState[] = [];
  const taken = new Set<string>();

  for (let index = 0; index < YARD.TRAIN_COUNT; index++) {
    const duty = weightedPick(rng, scene.duties, (candidate) => candidate.weight);
    const drawn = chooseItinerary(duty, rng);
    /*
     * Spread the opening across the sheds. There are more trains than depots, so this
     * only prefers a free one — the node claim below is what actually keeps two
     * locomotives from occupying the same rail, and the warm-up disperses them anyway.
     */
    const home = duty.home.find((id) => !taken.has(id)) ?? drawn.home;
    taken.add(home);
    const itinerary: Itinerary = { ...drawn, home };
    trains.push({
      id: `train-${index}`,
      dutyId: duty.id,
      phase: "idle",
      path: findPath(graph, itinerary.home, itinerary.bay),
      distance: 0,
      speed: 0,
      timer: range(rng, YARD.IDLE_MS) + index * YARD.STAGGER_MS,
      handled: 0,
      target: rangeInt(rng, duty.wagons),
      wagons: [],
      itinerary,
      blocked: false,
      held: [],
      heldNode: null,
      sinceSmoke: 0,
    });
  }

  const world: WorldState = {
    graph,
    elapsedMs: 0,
    trains,
    occupancy: new Map(),
    puffs: [],
  };

  // Each train claims the depot it starts in, or two of them share a shed on the first
  // frame — the same overlap the node claim exists to prevent everywhere else.
  for (const train of trains) claimNode(world, train, train.itinerary.home);

  for (let elapsed = 0; elapsed < YARD.WARMUP_MS; elapsed += SIM.STEP_MS) {
    step(world, SIM.STEP_MS, rng);
  }
  return world;
}

/**
 * How many fixed steps a frame is worth, and what is left over.
 *
 * Extracted from the loop rather than written inline there because it carries the whole
 * catch-up contract and is otherwise unobservable: a hook cannot report how many times it
 * stepped. A tab asleep for four seconds must not run two hundred steps on the frame it
 * wakes on — that is a visible freeze followed by every train teleporting — so the excess
 * is dropped rather than repaid, and the remainder becomes the renderer's interpolation
 * alpha so motion stays smooth between two steps.
 */
export function stepsFor(
  accumulator: number,
  deltaMs: number,
): { steps: number; rest: number } {
  const clamped = Math.max(0, Math.min(deltaMs, SIM.MAX_CATCHUP_MS));
  const total = accumulator + clamped;
  const steps = Math.floor(total / SIM.STEP_MS);
  return { steps, rest: total - steps * SIM.STEP_MS };
}

/**
 * A JSON-safe deep copy, for the determinism assertions.
 *
 * The graph is deliberately absent: it is derived from the scene literal and identical
 * across any two worlds, so including it would make every comparison enormous and prove
 * nothing.
 */
export function snapshot(world: WorldState): unknown {
  return {
    elapsedMs: world.elapsedMs,
    occupancy: [...world.occupancy].sort(([a], [b]) => (a < b ? -1 : 1)),
    puffs: world.puffs.map((puff) => ({ ...puff })),
    trains: world.trains.map((train) => ({
      ...train,
      wagons: train.wagons.map((wagon) => ({ ...wagon })),
      held: [...train.held].sort(),
      path: train.path ? { ...train.path, edges: [...train.path.edges] } : null,
    })),
  };
}
