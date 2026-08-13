import { afterEach, describe, expect, it, vi } from "vitest";
import { CRANE, SIM, YARD } from "./config";
import { CRANE_CYCLE } from "./crane";
import { poseAlong } from "./graph";
import { FREIGHT_TOKENS } from "./palette";
import { createRng } from "./rng";
import {
  createWorld,
  snapshot,
  step,
  stepsFor,
  trainLength,
  type TrainPhase,
  type WorldState,
} from "./simulation";

const ALL_PHASES: readonly TrainPhase[] = [
  "idle",
  "outbound",
  "loading",
  "hauling",
  "away",
  "inbound",
  "unloading",
  "homebound",
];

/** A world and its stream, so a caller can keep stepping the one the warm-up left. */
function yard(seed: number = YARD.SEED) {
  const rng = createRng(seed);
  return { world: createWorld(rng), rng };
}

const run = (world: WorldState, rng: () => number, steps: number) => {
  for (let index = 0; index < steps; index++) step(world, SIM.STEP_MS, rng);
};

/** Every number reachable from a snapshot, so "no NaN anywhere" can be one assertion. */
function numbersIn(value: unknown, out: number[] = []): number[] {
  if (typeof value === "number") out.push(value);
  else if (Array.isArray(value)) for (const item of value) numbersIn(item, out);
  else if (value && typeof value === "object") {
    for (const item of Object.values(value)) numbersIn(item, out);
  }
  return out;
}

afterEach(() => vi.restoreAllMocks());

describe("determinism", () => {
  it("produces the same yard from the same seed", () => {
    const a = yard();
    const b = yard();
    run(a.world, a.rng, 4_000);
    run(b.world, b.rng, 4_000);
    expect(snapshot(a.world)).toEqual(snapshot(b.world));
  });

  it("produces a different yard from a different seed", () => {
    const a = yard();
    const b = yard(0xc0ffee);
    expect(snapshot(a.world)).not.toEqual(snapshot(b.world));
  });

  it("reads no ambient clock and no ambient randomness", () => {
    /*
     * The contract that makes the rest of this file meaningful, and the reason the still
     * frame a reduced-motion visitor gets is reviewable at all. Time arrives as dtMs and
     * chance as an explicit Rng; anything else would put wall-clock into a feature that is
     * otherwise free of it.
     */
    const rng = createRng(YARD.SEED);
    const world = createWorld(rng);
    vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("Math.random");
    });
    vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("Date.now");
    });
    expect(() => run(world, rng, 3_000)).not.toThrow();
  });

  it("holds every number finite over a long run", () => {
    // A NaN in a pose silently draws nothing in a real browser, so it has to be a test.
    const { world, rng } = yard();
    run(world, rng, 8_000);
    expect(numbersIn(snapshot(world)).every(Number.isFinite)).toBe(true);
  });
});

describe("the train lifecycle", () => {
  it("takes every train right round the cycle, in order", () => {
    /*
     * Liveness, and the deadlock test. Every train has to reach all eight phases inside a
     * quarter of an hour of simulated time, and the transitions have to follow the ring —
     * a train that skipped from loading to homebound would satisfy a set-membership check
     * and be badly broken.
     */
    const { world, rng } = yard();
    const seen = new Map(
      world.trains.map((train) => [train.id, new Set<TrainPhase>()]),
    );
    const bad: string[] = [];
    let previous = new Map(world.trains.map((train) => [train.id, train.phase]));

    for (let index = 0; index < 45_000; index++) {
      step(world, SIM.STEP_MS, rng);
      for (const train of world.trains) {
        seen.get(train.id)!.add(train.phase);
        const was = previous.get(train.id)!;
        if (was === train.phase) continue;
        const expected = ALL_PHASES[(ALL_PHASES.indexOf(was) + 1) % ALL_PHASES.length];
        if (train.phase !== expected) bad.push(`${train.id}: ${was} -> ${train.phase}`);
      }
      previous = new Map(world.trains.map((train) => [train.id, train.phase]));
    }

    expect(bad).toEqual([]);
    for (const [id, phases] of seen) {
      expect([...phases].sort(), id).toEqual([...ALL_PHASES].sort());
    }
  });

  it("never repositions a train", () => {
    /*
     * The regression test for "trains and containers appearing and disappearing suddenly".
     *
     * Four separate bugs produced that symptom and this one assertion covers all of them:
     * the path being nulled on departure, the arrival clamp telescoping a rake onto one
     * point, the rake collapsing on every new leg, and the idle teleport that rendered a
     * stabled train back in the middle of the yard for its whole dwell. Every one of them
     * shows up as a drawn position that moved further in a step than the train could
     * possibly have travelled.
     */
    const { world, rng } = yard();
    // Derived from the fastest edge in the scene, so adding a quicker road cannot quietly
    // widen what counts as a teleport.
    const quickest = Math.max(...world.graph.scene.edges.map((edge) => edge.speed));
    const ceiling = (YARD.BASE_SPEED * quickest * SIM.STEP_MS) / 1000 + 1;
    const last = new Map<string, { x: number; y: number }>();
    const jumps: string[] = [];

    for (let index = 0; index < 30_000; index++) {
      step(world, SIM.STEP_MS, rng);
      for (const train of world.trains) {
        const pose = poseAlong(world.graph, train.path, train.distance);
        expect(pose).not.toBeNull();
        const previous = last.get(train.id);
        if (previous) {
          const moved = Math.hypot(pose!.x - previous.x, pose!.y - previous.y);
          if (moved > ceiling) {
            jumps.push(`${train.id} ${train.phase} moved ${moved.toFixed(1)}`);
          }
        }
        last.set(train.id, { x: pose!.x, y: pose!.y });
      }
    }

    expect(jumps).toEqual([]);
  });

  it("leaves a stabled train standing in its shed for the whole dwell", () => {
    /*
     * The idle teleport, pinned directly. `homebound` used to reset distance to zero
     * without replacing the path, so a train that had just arrived was drawn at the *start*
     * of its homebound route — in the middle of the yard — until it was dispatched again.
     */
    const { world, rng } = yard();
    const shed = world.graph.nodes.get("shed-road")!;
    const away: string[] = [];

    for (let index = 0; index < 30_000; index++) {
      step(world, SIM.STEP_MS, rng);
      for (const train of world.trains) {
        if (train.phase !== "idle") continue;
        const pose = poseAlong(world.graph, train.path, train.distance)!;
        const off = Math.hypot(pose.x - shed.at[0], pose.y - shed.at[1]);
        if (off > 1) away.push(`${train.id} idles ${off.toFixed(1)} from the shed`);
      }
    }

    expect(away).toEqual([]);
  });

  it("keeps every train on a visible road while it is in the yard", () => {
    /*
     * A train off its road is a train drawn on the grass. The only exception is the return,
     * which is deliberately in front of the camera and below the canvas, so a train there
     * is checked for being *off* the yard rather than on it.
     */
    const { world, rng } = yard();
    const roads = world.graph.scene.roads.filter((road) => road.rail !== "hidden");
    const strays: string[] = [];

    for (let index = 0; index < 12_000; index++) {
      step(world, SIM.STEP_MS, rng);
      for (const train of world.trains) {
        const edge = world.graph.edges.get(
          train.path.edges[Math.min(train.path.edges.length - 1, 0)]!,
        );
        const onLoop = train.path.edges.some(
          (id) => world.graph.edges.get(id)?.kind === "hidden",
        );
        const pose = poseAlong(world.graph, train.path, train.distance)!;
        if (onLoop && pose.y < 0) continue;
        if (edge?.kind === "hidden") continue;
        const nearest = Math.min(...roads.map((road) => Math.abs(pose.y - road.y)));
        if (nearest > YARD.HEADWAY)
          strays.push(`${train.id} is ${nearest.toFixed(1)} off`);
      }
    }

    expect(strays).toEqual([]);
  });
});

describe("rolling stock", () => {
  it("never creates or destroys a wagon after the world is built", () => {
    /*
     * Wagons used to be pushed onto a train one per 900 ms while it stood at the bay and
     * thrown away when it got home, which is exactly what "appearing and disappearing"
     * looked like. A flat wagon is rolling stock; what comes and goes is what is on it.
     */
    const { world, rng } = yard();
    const opening = new Map(
      world.trains.map((train) => [train.id, train.wagons.length]),
    );
    const changes: string[] = [];

    for (let index = 0; index < 20_000; index++) {
      step(world, SIM.STEP_MS, rng);
      for (const train of world.trains) {
        if (train.wagons.length !== opening.get(train.id)) {
          changes.push(`${train.id} now has ${train.wagons.length}`);
        }
      }
    }

    expect(changes).toEqual([]);
    for (const count of opening.values()) {
      expect(count).toBeGreaterThanOrEqual(YARD.RAKE_SIZE[0]);
      expect(count).toBeLessThanOrEqual(YARD.RAKE_SIZE[1]);
    }
  });

  it("gives a loaded wagon a colour the palette can resolve", () => {
    const { world, rng } = yard();
    const bad: unknown[] = [];
    for (let index = 0; index < 12_000; index++) {
      step(world, SIM.STEP_MS, rng);
      for (const train of world.trains) {
        for (const wagon of train.wagons) {
          if (wagon.cargo === null) continue;
          if (
            !Number.isInteger(wagon.cargo) ||
            wagon.cargo < 0 ||
            wagon.cargo >= FREIGHT_TOKENS.length
          ) {
            bad.push(wagon.cargo);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("hauls loaded and comes home empty", () => {
    // The freight actually goes somewhere: a train leaves the loading road full and gets
    // back to its shed with bare flats.
    const { world, rng } = yard();
    const wrong: string[] = [];

    for (let index = 0; index < 30_000; index++) {
      step(world, SIM.STEP_MS, rng);
      for (const train of world.trains) {
        const loaded = train.wagons.filter((wagon) => wagon.cargo !== null).length;
        if (train.phase === "hauling" && loaded !== train.wagons.length) {
          wrong.push(`${train.id} hauls ${loaded}/${train.wagons.length}`);
        }
        if (train.phase === "idle" && loaded !== 0) {
          wrong.push(`${train.id} stables with ${loaded} still on`);
        }
      }
    }

    expect(wrong).toEqual([]);
  });

  it("grows the rake's length with its wagons", () => {
    const { world } = yard();
    for (const train of world.trains) {
      expect(trainLength(train)).toBeGreaterThan(train.wagons.length * 46);
    }
  });
});

describe("the crane", () => {
  it("works its cycle in order and holds a box only between the latches", () => {
    const { world, rng } = yard();
    const takeAt = CRANE_CYCLE.findIndex((leg) => leg.move === "latch");
    const dropAt = CRANE_CYCLE.findLastIndex((leg) => leg.move === "latch");
    const bad: string[] = [];
    let previous = world.crane.legIndex;

    for (let index = 0; index < 20_000; index++) {
      step(world, SIM.STEP_MS, rng);
      const { crane } = world;
      if (crane.legIndex !== previous && crane.servingTrainId !== null) {
        const expected = (previous + 1) % CRANE_CYCLE.length;
        if (crane.legIndex !== expected && crane.legIndex !== 0) {
          bad.push(`leg ${previous} -> ${crane.legIndex}`);
        }
      }
      previous = crane.legIndex;

      if (
        crane.holding !== null &&
        (crane.legIndex <= takeAt || crane.legIndex > dropAt)
      ) {
        bad.push(`holding at leg ${crane.legIndex}`);
      }
      if (crane.hoistZ > CRANE.TRAVEL_Z + 0.01) bad.push(`hoist above travel`);
      if (crane.stack.length > CRANE.STACK_CAPACITY) bad.push(`stack overfull`);
    }

    expect(bad).toEqual([]);
  });

  it("moves the containers rather than conjuring them", () => {
    /*
     * The total number of boxes in the yard changes only when the crane lets go of one —
     * onto a wagon, or onto a stack that is full and therefore trucks it away. Between
     * latches, nothing appears and nothing evaporates.
     */
    const { world, rng } = yard();
    const count = () =>
      world.crane.stack.length +
      (world.crane.holding === null ? 0 : 1) +
      world.trains.reduce(
        (sum, train) =>
          sum + train.wagons.filter((wagon) => wagon.cargo !== null).length,
        0,
      );

    let previous = count();
    const jumps: number[] = [];
    for (let index = 0; index < 20_000; index++) {
      step(world, SIM.STEP_MS, rng);
      const now = count();
      if (Math.abs(now - previous) > 1) jumps.push(now - previous);
      previous = now;
    }
    expect(jumps).toEqual([]);
  });

  it("serves a train that arrives while it is busy", () => {
    /*
     * Without a dispatcher a second train stands at the loading road for ever, because
     * nothing ever comes back and offers it a turn. This is the assertion that found it:
     * every train gets loaded, so every train must eventually be served.
     */
    const { world, rng } = yard();
    const served = new Set<string>();
    for (let index = 0; index < 45_000; index++) {
      step(world, SIM.STEP_MS, rng);
      if (world.crane.servingTrainId) served.add(world.crane.servingTrainId);
    }
    expect(served.size).toBe(world.trains.length);
  });
});

describe("traffic", () => {
  it("brakes rather than stopping dead", () => {
    /*
     * The headline defect of the old model. `reserve()` set `blocked` after the speed code
     * had already read it and the next step cleared it before the read, so a train stopped
     * by occupied track never braked at all — it ran at line speed into the boundary and
     * had its speed assigned to zero in a single 20 ms step. What you saw was a locomotive
     * hitting an invisible wall.
     */
    const { world, rng } = yard();
    const ceiling = (YARD.BRAKE * SIM.STEP_MS) / 1000 + 0.001;
    const speeds = new Map(world.trains.map((train) => [train.id, train.speed]));
    let phases = new Map(world.trains.map((train) => [train.id, train.phase]));
    const slams: string[] = [];

    for (let index = 0; index < 30_000; index++) {
      step(world, SIM.STEP_MS, rng);
      for (const train of world.trains) {
        const was = speeds.get(train.id)!;
        /*
         * The step a leg *ends* on is exempt. A train that has reached its stop has
         * stopped, and the last step of an approach lands on the node with whatever
         * fraction of a step's travel was left over — a discrete-time artefact, not a
         * brake. Everything else has to obey the brake rate, which is the whole assertion:
         * the bug this catches shed line speed in one step, mid-leg, without arriving
         * anywhere.
         */
        if (was - train.speed > ceiling && phases.get(train.id) === train.phase) {
          slams.push(`${train.id} ${was.toFixed(1)} -> ${train.speed.toFixed(1)}`);
        }
        speeds.set(train.id, train.speed);
      }
      phases = new Map(world.trains.map((train) => [train.id, train.phase]));
    }

    expect(slams).toEqual([]);
  });

  it("never runs one train through another", () => {
    /*
     * Two trains on the same road may not overlap, at any moment. The old model could not
     * even express this at a resolution finer than a whole edge — and two edges that
     * crossed without a shared node it could not express at all, which is how a pair of
     * locomotives came to drive through each other at (275.7, 81.6).
     */
    const { world, rng } = yard();
    const overlaps: string[] = [];

    for (let index = 0; index < 30_000; index++) {
      step(world, SIM.STEP_MS, rng);
      const bodies = world.trains.map((train) => ({
        id: train.id,
        pose: poseAlong(world.graph, train.path, train.distance)!,
        length: trainLength(train),
      }));
      for (let a = 0; a < bodies.length; a++) {
        for (let b = a + 1; b < bodies.length; b++) {
          const first = bodies[a]!;
          const second = bodies[b]!;
          if (Math.abs(first.pose.y - second.pose.y) > 8) continue;
          if (Math.abs(first.pose.x - second.pose.x) < 20) {
            overlaps.push(`${first.id} and ${second.id} share a nose`);
          }
        }
      }
    }

    expect(overlaps).toEqual([]);
  });

  it("lets a follower close up rather than waiting a whole road back", () => {
    /*
     * The resolution half of the traffic repair. A claim used to cover a whole edge, so two
     * trains could not be nearer than one edge apart — a follower on the loading road
     * stopped 230 units back and the two never looked aware of each other. Somewhere in a
     * long run, two trains should end up within sight of each other.
     */
    const { world, rng } = yard();
    let closest = Infinity;

    for (let index = 0; index < 30_000; index++) {
      step(world, SIM.STEP_MS, rng);
      const bodies = world.trains.map((train) => ({
        pose: poseAlong(world.graph, train.path, train.distance)!,
        length: trainLength(train),
      }));
      for (let a = 0; a < bodies.length; a++) {
        for (let b = a + 1; b < bodies.length; b++) {
          const first = bodies[a]!;
          const second = bodies[b]!;
          if (Math.abs(first.pose.y - second.pose.y) > 8) continue;
          const gap =
            Math.abs(first.pose.x - second.pose.x) -
            Math.max(first.length, second.length);
          closest = Math.min(closest, gap);
        }
      }
    }

    expect(closest).toBeLessThan(YARD.HEADWAY * 3);
  });

  it("keeps every train moving, so nothing waits for ever", () => {
    // A stall longer than the longest dwell in the yard is a queue that never cleared.
    const { world, rng } = yard();
    const stalled = new Map(world.trains.map((train) => [train.id, 0]));
    let worst = 0;

    for (let index = 0; index < 45_000; index++) {
      step(world, SIM.STEP_MS, rng);
      for (const train of world.trains) {
        const moving = train.speed > 0.01;
        const waiting = train.phase === "idle" || train.phase === "away";
        const held = moving || waiting ? 0 : stalled.get(train.id)! + SIM.STEP_MS;
        stalled.set(train.id, held);
        worst = Math.max(worst, held);
      }
    }

    // Loading a five-wagon rake is the longest a train legitimately stands still.
    expect(worst).toBeLessThan(120_000);
  });
});

describe("smoke", () => {
  it("meters puffs by travel rather than by time", () => {
    // A stationary locomotive stops smoking, which is what makes standing still read as
    // standing still. Metering by the clock had a train at a signal puffing away.
    const { world, rng } = yard();
    const before = new Map(
      world.trains.map((train) => [
        train.id,
        [train.sinceSmoke, train.distance] as const,
      ]),
    );
    const bad: string[] = [];

    for (let index = 0; index < 4_000; index++) {
      const phases = new Map(world.trains.map((train) => [train.id, train.phase]));
      step(world, SIM.STEP_MS, rng);
      for (const train of world.trains) {
        const [wasSmoke, wasDistance] = before.get(train.id)!;
        const samePhase = phases.get(train.id) === train.phase;
        const grew = train.sinceSmoke - wasSmoke;
        const moved = train.distance - wasDistance;
        if (samePhase && grew > 0 && Math.abs(grew - moved) > 0.001) {
          bad.push(`${train.id} smoked ${grew} over ${moved}`);
        }
        before.set(train.id, [train.sinceSmoke, train.distance]);
      }
    }

    expect(bad).toEqual([]);
  });

  it("holds the puff count under its ceiling", () => {
    const { world, rng } = yard();
    let most = 0;
    for (let index = 0; index < 8_000; index++) {
      step(world, SIM.STEP_MS, rng);
      most = Math.max(most, world.puffs.length);
    }
    expect(most).toBeGreaterThan(0);
    expect(most).toBeLessThanOrEqual(YARD.MAX_PUFFS);
  });

  it("rises in height rather than into the scene", () => {
    /*
     * Height, not depth. Adding the rise to world y would push a puff *backwards* under
     * this projection — it would drift towards the horizon instead of upwards, which is
     * what the previous version did with the chimney offset.
     */
    const { world, rng } = yard();
    run(world, rng, 400);
    const puff = world.puffs[0];
    expect(puff).toBeDefined();
    const startZ = puff!.z;
    const startY = puff!.y;
    run(world, rng, 20);
    expect(puff!.z).toBeGreaterThan(startZ);
    expect(puff!.y).toBe(startY);
  });
});

describe("stepsFor", () => {
  it("turns a frame delta into whole steps and a remainder", () => {
    expect(stepsFor(0, 100)).toEqual({ steps: 5, rest: 0 });
    expect(stepsFor(0, 30)).toEqual({ steps: 1, rest: 10 });
    expect(stepsFor(10, 30)).toEqual({ steps: 2, rest: 0 });
  });

  it("clamps a long stall instead of running the catch-up", () => {
    // A tab that wakes after four seconds must not run two hundred steps on the frame it
    // wakes on: that is a visible freeze followed by every train teleporting.
    expect(stepsFor(0, 5_000).steps).toBe(SIM.MAX_CATCHUP_MS / SIM.STEP_MS);
  });

  it("ignores a clock that went backwards", () => {
    expect(stepsFor(0, -50)).toEqual({ steps: 0, rest: 0 });
  });
});

describe("createWorld", () => {
  it("opens with a yard already at work", () => {
    /*
     * Step zero is three locomotives asleep in a shed, which is a picture of nothing — and
     * it is exactly what a reduced-motion visitor gets instead of the animation. The
     * warm-up runs the real simulation rather than hand-placing trains, so it cannot drift
     * out of agreement with the rules.
     */
    const { world } = yard();
    expect(world.elapsedMs).toBe(YARD.WARMUP_MS);
    expect(world.trains).toHaveLength(YARD.TRAIN_COUNT);
    expect(world.trains.some((train) => train.phase !== "idle")).toBe(true);
    expect(world.trains.some((train) => train.speed > 0)).toBe(true);
  });

  it("keeps a pile in the yard without ever burying it", () => {
    /*
     * The stack swings: with twelve containers in circulation and six slots on the ground,
     * it empties when every train is loaded and fills when every train is not. That is a
     * working yard rather than a defect — what would be a defect is a pile that overflowed
     * its own slots, or one that was never there at all.
     */
    const { world, rng } = yard();
    let stocked = 0;
    let over = 0;
    for (let index = 0; index < 20_000; index++) {
      step(world, SIM.STEP_MS, rng);
      if (world.crane.stack.length > 0) stocked += 1;
      if (world.crane.stack.length > CRANE.STACK_CAPACITY) over += 1;
    }
    expect(over).toBe(0);
    expect(stocked).toBeGreaterThan(20_000 / 4);
  });

  it("gives every train a path it is standing on", () => {
    const { world } = yard();
    for (const train of world.trains) {
      expect(train.path.edges.length, train.id).toBeGreaterThan(0);
      expect(
        poseAlong(world.graph, train.path, train.distance),
        train.id,
      ).not.toBeNull();
    }
  });
});
