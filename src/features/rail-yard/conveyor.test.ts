import { describe, expect, it } from "vitest";
import { CONVEYOR } from "./config";
import { CONTAINER } from "./sprites";
import {
  capacityOf,
  createConveyor,
  headClear,
  headLoaded,
  putOnBelt,
  stepConveyor,
  takeFromBelt,
  type Conveyor,
} from "./conveyor";
import { FREIGHT_TOKENS } from "./palette";
import { createRng } from "./rng";

const HEAD = 1000;
const TAIL = 1460;

const belt = (running: Conveyor["running"] = "in"): Conveyor => ({
  headX: HEAD,
  tailX: TAIL,
  y: 200,
  boxes: [],
  running,
});

/** Runs the belt for a while at the simulation's own step, so timings mean something. */
function run(conveyor: Conveyor, ms: number, seed = 1): void {
  const rng = createRng(seed);
  for (let at = 0; at < ms; at += 20) stepConveyor(conveyor, 20, rng);
}

describe("capacityOf", () => {
  it("counts the slots between the head and the tail", () => {
    expect(capacityOf(belt())).toBe(Math.ceil((TAIL - HEAD) / CONVEYOR.PITCH));
    // Every slot is west of the tail, so nothing is ever queued off the end of the belt.
    expect(HEAD + (capacityOf(belt()) - 1) * CONVEYOR.PITCH).toBeLessThan(TAIL);
  });

  it("holds at least one box however short the belt is", () => {
    expect(capacityOf({ ...belt(), tailX: HEAD })).toBe(1);
  });
});

describe("stepConveyor while feeding", () => {
  it("fills the head slot from an empty belt without being told to", () => {
    /*
     * The whole of "the belt always has containers". The crane's cycle takes seconds to
     * cross the yard and come back; the belt covers a pitch in under one, so the slot it
     * emptied is refilled before it returns. Nothing schedules that — it falls out of the
     * two speeds.
     */
    const conveyor = belt();
    run(conveyor, 20_000);
    expect(headLoaded(conveyor)).toBe(true);
    expect(conveyor.boxes[0]!.at).toBe(HEAD);
  });

  it("never puts two boxes in the same place", () => {
    const conveyor = belt();
    const rng = createRng(7);
    for (let at = 0; at < 40_000; at += 20) {
      stepConveyor(conveyor, 20, rng);
      for (let index = 1; index < conveyor.boxes.length; index++) {
        const gap = conveyor.boxes[index]!.at - conveyor.boxes[index - 1]!.at;
        expect(gap, `boxes ${index - 1} and ${index}`).toBeGreaterThanOrEqual(
          CONVEYOR.PITCH - 1e-9,
        );
      }
    }
  });

  it("stops taking freight once it is full, rather than piling up off camera", () => {
    // "Endless queue with capacity" — endless because the tail is somewhere else, capped
    // because the belt is a real length of machinery and not a number that grows.
    const conveyor = belt();
    run(conveyor, 300_000);
    expect(conveyor.boxes.length).toBe(capacityOf(conveyor));
  });

  it("closes the queue up when the crane lifts the leading box off", () => {
    const conveyor = belt();
    run(conveyor, 60_000);
    const following = conveyor.boxes[1]!.at;

    expect(takeFromBelt(conveyor)).not.toBeNull();
    expect(conveyor.boxes[0]!.at).toBe(following);
    run(conveyor, 2_000);
    expect(conveyor.boxes[0]!.at).toBe(HEAD);
  });

  it("gives the crane nothing when nothing has settled in the head slot", () => {
    // A box invented on an empty belt is the defect this file exists to remove. The crane
    // is held off the slot as well, so this is belt and braces on purpose.
    expect(takeFromBelt(belt())).toBeNull();
  });
});

describe("stepConveyor while clearing", () => {
  it("opens the head slot so the crane has somewhere to set a box down", () => {
    /*
     * The user's "two-way conveyor — making space for one when unloading". Making room at
     * the head and carrying the far end away are the same movement, which is why there is
     * only one of them: every box runs a pitch east and the last one runs off the end.
     */
    const conveyor = belt();
    run(conveyor, 60_000);
    expect(headClear(conveyor)).toBe(false);

    conveyor.running = "out";
    run(conveyor, 2_000);
    expect(headClear(conveyor)).toBe(true);
  });

  it("carries freight away past the tail rather than deleting it where it stands", () => {
    const conveyor = belt();
    run(conveyor, 60_000);
    const before = conveyor.boxes.length;

    conveyor.running = "out";
    run(conveyor, 2_000);
    expect(conveyor.boxes.length).toBe(before - 1);
    // And what left did so at the far end, off camera, not in the middle of the yard.
    expect(conveyor.boxes[conveyor.boxes.length - 1]!.at).toBeLessThan(TAIL);
  });

  it("takes a box from the crane into the slot it just opened", () => {
    const conveyor = belt("out");
    run(conveyor, 2_000);
    const freight = { colour: 3, ribs: 6 };
    putOnBelt(conveyor, freight);
    expect(conveyor.boxes[0]).toEqual({ freight, at: HEAD });
  });

  it("refuses a box when the head slot is still occupied", () => {
    // Never stacked, never overlapped: the belt is one box deep and says so.
    const conveyor = belt();
    run(conveyor, 60_000);
    const before = conveyor.boxes.length;
    putOnBelt(conveyor, { colour: 3, ribs: 6 });
    expect(conveyor.boxes.length).toBe(before);
  });
});

describe("createConveyor", () => {
  it("opens with freight already standing in its slots", () => {
    const conveyor = createConveyor(createRng(1), HEAD, TAIL, 200);
    expect(conveyor.boxes.length).toBe(Math.min(CONVEYOR.FLOOR, capacityOf(conveyor)));
    expect(conveyor.running).toBe("in");
    expect(headLoaded(conveyor)).toBe(true);
    conveyor.boxes.forEach((box, index) => {
      expect(box.at).toBe(HEAD + index * CONVEYOR.PITCH);
      expect(box.freight.colour).toBeGreaterThanOrEqual(0);
      expect(box.freight.colour).toBeLessThan(FREIGHT_TOKENS.length);
      // Corrugation travels with the box, so it has one before it is ever set down.
      expect(box.freight.ribs).toBeGreaterThanOrEqual(CONTAINER.ribs[0]);
      expect(box.freight.ribs).toBeLessThanOrEqual(CONTAINER.ribs[1]);
    });
  });

  it("never seeds past what the belt holds", () => {
    const conveyor = createConveyor(createRng(1), HEAD, HEAD + CONVEYOR.PITCH, 200);
    expect(conveyor.boxes.length).toBe(capacityOf(conveyor));
  });
});
