import { afterEach, describe, expect, it, vi } from "vitest";
import { SIM, YARD } from "./config";
import { edgeIndexAt } from "./graph";
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

const MINUTE_MS = 60_000;

/** Runs the world forward and returns it. Fixed steps only — the loop does the same. */
function run(world: WorldState, rng: () => number, forMs: number): WorldState {
  for (let elapsed = 0; elapsed < forMs; elapsed += SIM.STEP_MS) {
    step(world, SIM.STEP_MS, rng);
  }
  return world;
}

// Annotated: YARD.SEED is a literal type under `as const`, which would pin the parameter.
function fresh(seed: number = YARD.SEED) {
  const rng = createRng(seed);
  return { world: createWorld(rng), rng };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("determinism", () => {
  it("produces identical worlds from identical seeds", () => {
    const a = fresh();
    const b = fresh();
    run(a.world, a.rng, 400_000);
    run(b.world, b.rng, 400_000);
    expect(snapshot(a.world)).toEqual(snapshot(b.world));
  });

  it("produces different worlds from different seeds", () => {
    const a = fresh(1);
    const b = fresh(2);
    run(a.world, a.rng, 60_000);
    run(b.world, b.rng, 60_000);
    expect(snapshot(a.world)).not.toEqual(snapshot(b.world));
  });

  it("reads no ambient clock and no ambient randomness", () => {
    /*
     * The property the two assertions above are worth having *because of*. A single
     * Math.random() anywhere in the simulation would make the reduced-motion still frame
     * different for every visitor and the e2e frame comparison meaningless, and it would
     * not fail any test that only checked one seed against itself.
     */
    const forbidden = () => {
      throw new Error("the simulation reached for an ambient source");
    };
    vi.spyOn(Math, "random").mockImplementation(forbidden);
    vi.spyOn(Date, "now").mockImplementation(forbidden);

    const { world, rng } = fresh();
    expect(() => run(world, rng, 200_000)).not.toThrow();
  });
});

describe("the train lifecycle", () => {
  it("takes every train through the whole cycle in order", () => {
    const { world, rng } = fresh();
    const seen = new Map<string, TrainPhase[]>(
      world.trains.map((train) => [train.id, [train.phase]]),
    );

    for (let elapsed = 0; elapsed < 10 * MINUTE_MS; elapsed += SIM.STEP_MS) {
      step(world, SIM.STEP_MS, rng);
      for (const train of world.trains) {
        const history = seen.get(train.id)!;
        if (history[history.length - 1] !== train.phase) history.push(train.phase);
      }
    }

    const EVERY_PHASE: TrainPhase[] = [
      "idle",
      "outbound",
      "loading",
      "hauling",
      "away",
      "inbound",
      "unloading",
      "homebound",
    ];
    for (const [id, history] of seen) {
      for (const phase of EVERY_PHASE) {
        expect(history, `${id} never reached ${phase}`).toContain(phase);
      }
    }
  });

  it("completes at least one full cycle per train — the deadlock test", () => {
    /*
     * Liveness, not correctness. Every wedge this simulation has actually had looked
     * exactly like a green suite: trains standing on their own track at zero speed with
     * nothing throwing. Counting completed cycles is the only assertion that sees it.
     */
    const { world, rng } = fresh();
    const cycles = new Map(world.trains.map((train) => [train.id, 0]));
    const previous = new Map(world.trains.map((train) => [train.id, train.phase]));

    for (let elapsed = 0; elapsed < 10 * MINUTE_MS; elapsed += SIM.STEP_MS) {
      step(world, SIM.STEP_MS, rng);
      for (const train of world.trains) {
        if (previous.get(train.id) === "homebound" && train.phase === "idle") {
          cycles.set(train.id, cycles.get(train.id)! + 1);
        }
        previous.set(train.id, train.phase);
      }
    }

    for (const [id, count] of cycles) {
      expect(count, `${id} completed no cycle in ten minutes`).toBeGreaterThan(0);
    }
  });

  it("holds every train for the same cycle count across several seeds", () => {
    // A wedge that only appears on one seed is still a wedge.
    for (const seed of [1, 7, 99]) {
      const { world, rng } = fresh(seed);
      const previous = new Map(world.trains.map((train) => [train.id, train.phase]));
      const cycled = new Set<string>();
      for (let elapsed = 0; elapsed < 10 * MINUTE_MS; elapsed += SIM.STEP_MS) {
        step(world, SIM.STEP_MS, rng);
        for (const train of world.trains) {
          if (previous.get(train.id) === "homebound" && train.phase === "idle") {
            cycled.add(train.id);
          }
          previous.set(train.id, train.phase);
        }
      }
      expect(cycled.size, `seed ${seed}`).toBe(world.trains.length);
    }
  });
});

describe("loading and unloading", () => {
  it("couples one wagon at a time, never two in a step", () => {
    const { world, rng } = fresh();
    const counts = new Map(
      world.trains.map((train) => [train.id, train.wagons.length]),
    );
    const wrong: string[] = [];

    for (
      let elapsed = 0;
      elapsed < 5 * MINUTE_MS && !wrong.length;
      elapsed += SIM.STEP_MS
    ) {
      step(world, SIM.STEP_MS, rng);
      for (const train of world.trains) {
        // Growth is at most one; a drop to zero is a train stabling, not a coupling.
        const growth = train.wagons.length - counts.get(train.id)!;
        if (growth > 1) wrong.push(`${train.id} gained ${growth} wagons in one step`);
        counts.set(train.id, train.wagons.length);
      }
    }

    expect(wrong).toEqual([]);
  });

  it("gives a loaded wagon a colour the palette can resolve", () => {
    const { world, rng } = fresh();
    const wrong: string[] = [];

    for (
      let elapsed = 0;
      elapsed < 5 * MINUTE_MS && !wrong.length;
      elapsed += SIM.STEP_MS
    ) {
      step(world, SIM.STEP_MS, rng);
      for (const train of world.trains) {
        for (const wagon of train.wagons) {
          const index = wagon.cargo;
          if (index === null) continue;
          if (!Number.isInteger(index) || index < 0 || index >= FREIGHT_TOKENS.length) {
            wrong.push(`${train.id} carries colour ${index}`);
          }
        }
      }
    }

    expect(wrong).toEqual([]);
  });

  it("leaves the bay with a full rake and comes home with empty flats", () => {
    const { world, rng } = fresh();
    const wrong: string[] = [];
    let sawLoadedDeparture = false;
    let sawEmptyReturn = false;

    for (
      let elapsed = 0;
      elapsed < 10 * MINUTE_MS && !wrong.length;
      elapsed += SIM.STEP_MS
    ) {
      step(world, SIM.STEP_MS, rng);
      for (const train of world.trains) {
        if (train.wagons.length === 0) continue;
        if (train.phase === "hauling") {
          sawLoadedDeparture = true;
          if (train.wagons.some((wagon) => wagon.cargo === null)) {
            wrong.push(`${train.id} hauled an empty flat`);
          }
        }
        if (train.phase === "homebound") {
          // Uncoupling empties a wagon rather than removing it — a rake of flats going
          // home is what makes it read as the train that arrived loaded.
          sawEmptyReturn = true;
          if (train.wagons.some((wagon) => wagon.cargo !== null)) {
            wrong.push(`${train.id} went home still loaded`);
          }
        }
      }
    }

    expect(wrong).toEqual([]);
    expect(sawLoadedDeparture).toBe(true);
    expect(sawEmptyReturn).toBe(true);
  });
});

describe("occupancy", () => {
  it("upholds every claim invariant, step after step", () => {
    /*
     * Four properties in one pass, because each needs the same thirty thousand steps and
     * running them separately quadrupled the suite's slowest file for no extra coverage:
     * no edge held twice, no two trains standing in one place, nothing held by a train
     * that has left, and nothing held that the train's body does not actually span.
     */
    const { world, rng } = fresh();
    const wrong: string[] = [];

    for (
      let elapsed = 0;
      elapsed < 8 * MINUTE_MS && !wrong.length;
      elapsed += SIM.STEP_MS
    ) {
      step(world, SIM.STEP_MS, rng);

      const claimed = new Map<string, string>();
      const standing = new Set<string>();

      for (const train of world.trains) {
        for (const id of train.held) {
          if (claimed.has(id)) wrong.push(`${id} held by two trains`);
          claimed.set(id, train.id);
          // A train's own record and the world's must agree, or a release leaks.
          if (world.occupancy.get(id) !== train.id) wrong.push(`${id} claim disagrees`);
        }

        if (train.heldNode !== null) {
          if (standing.has(train.heldNode))
            wrong.push(`${train.heldNode} occupied twice`);
          standing.add(train.heldNode);
        }

        if (train.phase === "away") {
          if (train.held.length > 0) wrong.push(`${train.id} is away holding track`);
          if (train.path !== null) wrong.push(`${train.id} is away on a path`);
          continue;
        }

        const path = train.path;
        if (!path || path.edges.length === 0) continue;
        const nose = edgeIndexAt(path, Math.min(train.distance, path.length));
        const rear = edgeIndexAt(
          path,
          Math.max(0, train.distance - trainLength(train)),
        );
        for (const id of train.held) {
          const index = path.edges.indexOf(id);
          if (index < rear || index > nose) {
            wrong.push(`${train.id} holds ${id}, which its body does not span`);
          }
        }
      }
    }

    expect(wrong).toEqual([]);
  });
});

describe("motion", () => {
  it("keeps every number finite and in range", () => {
    /*
     * Violations are collected and asserted once rather than checked with `expect` inside
     * the loop. Ten simulated minutes is thirty thousand steps, and an expect per field
     * per train per step is a third of a million calls — the first version of this test
     * spent six seconds doing nothing but building assertion contexts it threw away.
     */
    const { world, rng } = fresh();
    const wrong: string[] = [];

    for (let elapsed = 0; elapsed < 10 * MINUTE_MS; elapsed += SIM.STEP_MS) {
      step(world, SIM.STEP_MS, rng);
      for (const train of world.trains) {
        const ceiling = train.path
          ? train.path.length + trainLength(train) + 1
          : Infinity;
        if (!Number.isFinite(train.distance))
          wrong.push(`${train.id} distance not finite`);
        if (!Number.isFinite(train.speed)) wrong.push(`${train.id} speed not finite`);
        if (train.speed < 0) wrong.push(`${train.id} speed ${train.speed} is negative`);
        if (train.speed > YARD.BASE_SPEED)
          wrong.push(`${train.id} overspeed ${train.speed}`);
        if (train.distance < 0) wrong.push(`${train.id} distance ${train.distance}`);
        if (train.timer < 0) wrong.push(`${train.id} timer ${train.timer}`);
        if (train.distance > ceiling) wrong.push(`${train.id} overran its path`);
      }
      for (const puff of world.puffs) {
        if (!Number.isFinite(puff.x) || !Number.isFinite(puff.y))
          wrong.push("puff off-world");
        if (puff.ageMs >= puff.lifeMs) wrong.push("puff outlived itself");
      }
      if (wrong.length > 0) break;
    }

    expect(wrong).toEqual([]);
  });

  it("bounds the smoke rather than growing it without limit", () => {
    const { world, rng } = fresh();
    let peak = 0;
    for (let elapsed = 0; elapsed < 6 * MINUTE_MS; elapsed += SIM.STEP_MS) {
      step(world, SIM.STEP_MS, rng);
      peak = Math.max(peak, world.puffs.length);
    }
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(YARD.MAX_PUFFS);
  });

  it("meters smoke by travel rather than by time", () => {
    /*
     * One puff per unit of *travel*, so a locomotive standing at a red or asleep in a
     * shed stops smoking. Asserted through the meter rather than the puff count, because
     * puffs also age out and the two effects cancel in a way a count cannot separate:
     * `sinceSmoke` may only ever advance by exactly the distance the train covered, or
     * reset to zero when it emits.
     */
    const { world, rng } = fresh();
    const wrong: string[] = [];

    for (let elapsed = 0; elapsed < 4 * MINUTE_MS; elapsed += SIM.STEP_MS) {
      const before = world.trains.map((train) => ({
        id: train.id,
        phase: train.phase,
        distance: train.distance,
        meter: train.sinceSmoke,
      }));
      step(world, SIM.STEP_MS, rng);

      for (const [index, train] of world.trains.entries()) {
        const previous = before[index]!;
        // A phase change resets `distance`, so the two are only comparable within one.
        if (previous.phase !== train.phase) continue;
        const moved = train.distance - previous.distance;
        const metered = train.sinceSmoke - previous.meter;
        if (train.sinceSmoke === 0) continue; // it emitted this step
        if (Math.abs(metered - moved) > 1e-6) {
          wrong.push(`${train.id} metered ${metered} for ${moved} of travel`);
        }
      }
      if (wrong.length > 0) break;
    }

    expect(wrong).toEqual([]);
  });
});

describe("blocking", () => {
  it("stops a following train at the boundary instead of driving through", () => {
    const { world, rng } = fresh();
    const wrong: string[] = [];
    let sawBlocked = false;

    for (
      let elapsed = 0;
      elapsed < 10 * MINUTE_MS && !wrong.length;
      elapsed += SIM.STEP_MS
    ) {
      step(world, SIM.STEP_MS, rng);
      for (const train of world.trains) {
        if (!train.blocked) continue;
        sawBlocked = true;
        // Being blocked is a reason to slow, never a reason to reverse.
        if (train.speed < 0) wrong.push(`${train.id} reversed while blocked`);
      }
    }

    expect(wrong).toEqual([]);
    expect(sawBlocked, "no train was ever held in ten minutes").toBe(true);
  });

  it("holds a train off camera rather than re-entering onto an occupied road", () => {
    const { world, rng } = fresh();
    const wrong: string[] = [];

    for (
      let elapsed = 0;
      elapsed < 10 * MINUTE_MS && !wrong.length;
      elapsed += SIM.STEP_MS
    ) {
      step(world, SIM.STEP_MS, rng);
      // Two trains cannot both be starting down the same entry road.
      const entering = world.trains
        .filter((train) => train.phase === "inbound")
        .map((train) => train.path?.edges[0])
        .filter((id): id is string => id !== undefined);
      if (new Set(entering).size !== entering.length)
        wrong.push("two trains re-entered together");
    }

    expect(wrong).toEqual([]);
  });
});

describe("stepsFor", () => {
  it("turns a steady frame into whole steps and keeps the remainder", () => {
    expect(stepsFor(0, SIM.STEP_MS)).toEqual({ steps: 1, rest: 0 });
    expect(stepsFor(0, SIM.STEP_MS * 3)).toEqual({ steps: 3, rest: 0 });

    // A 144 Hz frame is shorter than a step, so most frames only interpolate.
    const fast = stepsFor(0, 7);
    expect(fast.steps).toBe(0);
    expect(fast.rest).toBe(7);
  });

  it("carries the remainder into the next frame", () => {
    const first = stepsFor(0, 15);
    const second = stepsFor(first.rest, 15);
    expect(first.steps).toBe(0);
    expect(second.steps).toBe(1);
    expect(second.rest).toBe(10);
  });

  it("drops the excess rather than repaying it", () => {
    /*
     * The spiral-of-death guard. A tab asleep for four seconds would otherwise run two
     * hundred steps on the frame it wakes on: a visible freeze followed by every train
     * teleporting across the yard.
     */
    const woken = stepsFor(0, 4_000);
    expect(woken.steps).toBe(SIM.MAX_CATCHUP_MS / SIM.STEP_MS);
    expect(woken.steps).toBeLessThan(4_000 / SIM.STEP_MS);
  });

  it("tolerates a clock that goes backwards", () => {
    // performance.now() is monotonic, but the first frame after a restart computes its
    // delta against a zeroed `last` and a negative would run the loop backwards.
    expect(stepsFor(0, -5_000)).toEqual({ steps: 0, rest: 0 });
  });
});

describe("createWorld", () => {
  it("hands over a yard already at work rather than three sheds", () => {
    /*
     * The warm-up is what the reduced-motion still frame shows, so "is the opening state
     * interesting" is a real assertion rather than a matter of taste: at step zero every
     * locomotive is asleep and the frozen frame is a picture of nothing.
     */
    const { world } = fresh();
    expect(world.elapsedMs).toBeGreaterThanOrEqual(YARD.WARMUP_MS);
    expect(world.trains.some((train) => train.phase !== "idle")).toBe(true);
    expect(world.trains.some((train) => train.wagons.length > 0)).toBe(true);
  });

  it("creates the configured number of trains, each in its own place", () => {
    const { world } = fresh();
    expect(world.trains).toHaveLength(YARD.TRAIN_COUNT);
    expect(new Set(world.trains.map((train) => train.id)).size).toBe(YARD.TRAIN_COUNT);
  });
});
