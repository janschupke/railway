import { describe, expect, it } from "vitest";
import { CRANE, GANTRY } from "./config";
import {
  CRANE_CYCLE,
  assignCrane,
  createCrane,
  releaseCrane,
  stepCrane,
  wagonNoseDistance,
  type CraneState,
  type CraneTarget,
} from "./crane";
import { createRng } from "./rng";

const TARGET: CraneTarget = { wagonX: 900, wagonY: 120, stackX: 1200, stackY: 240 };

/** Runs the crane until it reports an event or gives up, so a leg can be watched end to end. */
function until(crane: CraneState, event: "closed" | "opened", steps = 4_000): number {
  for (let index = 0; index < steps; index++) {
    if (stepCrane(crane, 20, TARGET) === event) return index;
  }
  throw new Error(`crane never reported ${event}`);
}

describe("createCrane", () => {
  it("parks with an empty spreader and some freight on the ground", () => {
    const crane = createCrane(createRng(1), 800, 240);
    expect(crane.portalX).toBe(800);
    expect(crane.trolleyY).toBe(240);
    expect(crane.hoistZ).toBe(CRANE.TRAVEL_Z);
    expect(crane.holding).toBeNull();
    expect(crane.servingTrainId).toBeNull();
    expect(crane.stack.length).toBeGreaterThan(0);
    expect(crane.stack.length).toBeLessThanOrEqual(CRANE.STACK_CAPACITY);
  });
});

describe("stepCrane", () => {
  it("does nothing at all when it has no train to serve", () => {
    const crane = createCrane(createRng(1), 800, 240);
    const before = { ...crane };
    expect(stepCrane(crane, 20, TARGET)).toBeNull();
    expect(crane.portalX).toBe(before.portalX);
    expect(crane.legIndex).toBe(before.legIndex);
  });

  it("works its ten legs in order and comes back round", () => {
    const crane = createCrane(createRng(1), 800, 240);
    assignCrane(crane, "train-0", "load");

    const seen: number[] = [crane.legIndex];
    for (let index = 0; index < 6_000; index++) {
      const was = crane.legIndex;
      stepCrane(crane, 20, TARGET);
      if (crane.legIndex !== was) seen.push(crane.legIndex);
      if (seen.length > CRANE_CYCLE.length) break;
    }
    expect(seen).toEqual([...CRANE_CYCLE.keys(), 0]);
  });

  it("drives each axis at its own speed and stops when it arrives", () => {
    const crane = createCrane(createRng(1), 800, 240);
    assignCrane(crane, "train-0", "load");

    // Leg one is the portal running to the stack. Its x is the only thing that may move.
    const depth = crane.trolleyY;
    stepCrane(crane, 20, TARGET);
    expect(crane.portalX).toBeCloseTo(800 + (CRANE.PORTAL_SPEED * 20) / 1000);
    expect(crane.trolleyY).toBe(depth);

    while (crane.legIndex === 0) stepCrane(crane, 20, TARGET);
    expect(crane.portalX).toBeCloseTo(TARGET.stackX);
  });

  it("closes on a box at the top of the stack and opens over the wagon deck", () => {
    /*
     * The interlock the whole feature turns on: a container is only ever somewhere. The
     * crane reports the latch and the simulation does the accounting, because the
     * simulation is what owns the wagons — reading `holding` here was how a whole rake got
     * loaded with nothing.
     */
    const crane = createCrane(createRng(1), 800, 240);
    assignCrane(crane, "train-0", "load");

    until(crane, "closed");
    expect(crane.trolleyY).toBeCloseTo(TARGET.stackY);
    const grabbedAt = crane.hoistZ;
    expect(grabbedAt).toBeLessThan(CRANE.TRAVEL_Z);

    until(crane, "opened");
    expect(crane.portalX).toBeCloseTo(TARGET.wagonX);
    expect(crane.trolleyY).toBeCloseTo(TARGET.wagonY);
  });

  it("takes from the wagon and puts on the stack when it is unloading", () => {
    // One machine, source and sink exchanged. Two of them would be two things to keep in
    // step, and nine handlers would be nine functions each needing a test of its own.
    const crane = createCrane(createRng(1), 800, 240);
    assignCrane(crane, "train-0", "unload");

    until(crane, "closed");
    expect(crane.portalX).toBeCloseTo(TARGET.wagonX);
    expect(crane.trolleyY).toBeCloseTo(TARGET.wagonY);

    until(crane, "opened");
    expect(crane.portalX).toBeCloseTo(TARGET.stackX);
    expect(crane.trolleyY).toBeCloseTo(TARGET.stackY);
  });

  it("never lifts the spreader above its travel height", () => {
    // It has to clear a full stack plus the box hanging under it, and nothing more —
    // going higher would put the hoist through the beam it hangs from.
    const crane = createCrane(createRng(1), 800, 240);
    assignCrane(crane, "train-0", "load");
    for (let index = 0; index < 4_000; index++) {
      stepCrane(crane, 20, TARGET);
      expect(crane.hoistZ).toBeLessThanOrEqual(CRANE.TRAVEL_Z + 1e-9);
      expect(crane.hoistZ).toBeGreaterThanOrEqual(0);
    }
  });

  it("stops lower over a bare stack than over a full one", () => {
    const low = createCrane(createRng(1), 800, 240);
    low.stack = [];
    assignCrane(low, "train-0", "load");
    until(low, "closed");

    const high = createCrane(createRng(1), 800, 240);
    high.stack = [0, 1, 2];
    assignCrane(high, "train-0", "load");
    until(high, "closed");

    expect(high.hoistZ).toBeGreaterThan(low.hoistZ);
    expect(low.hoistZ).toBeCloseTo(GANTRY.spreaderHeight);
  });

  it("reaches lower to set a box down than to pick one up", () => {
    // Picking up means landing on the box already there; setting down means the bare deck.
    const load = createCrane(createRng(1), 800, 240);
    assignCrane(load, "train-0", "load");
    until(load, "opened");
    const placed = load.hoistZ;

    const unload = createCrane(createRng(1), 800, 240);
    assignCrane(unload, "train-0", "unload");
    until(unload, "closed");
    expect(unload.hoistZ).toBeGreaterThan(placed);
  });
});

describe("assignCrane and releaseCrane", () => {
  it("restarts the cycle so the first leg runs", () => {
    const crane = createCrane(createRng(1), 800, 240);
    crane.legIndex = 5;
    crane.wagonIndex = 3;
    assignCrane(crane, "train-1", "unload");
    expect(crane).toMatchObject({
      servingTrainId: "train-1",
      direction: "unload",
      legIndex: 0,
      wagonIndex: 0,
      holding: null,
    });
  });

  it("lets go of the train and of anything in its jaws", () => {
    const crane = createCrane(createRng(1), 800, 240);
    assignCrane(crane, "train-1", "load");
    crane.holding = 2;
    releaseCrane(crane);
    expect(crane.servingTrainId).toBeNull();
    expect(crane.holding).toBeNull();
  });
});

describe("wagonNoseDistance", () => {
  it("counts back from the locomotive, wagon by wagon", () => {
    const first = wagonNoseDistance(1000, 0);
    const second = wagonNoseDistance(1000, 1);
    expect(first).toBeLessThan(1000);
    expect(second).toBeLessThan(first);
    // Even spacing, which is what lets the crane serve wagon k without asking the renderer.
    expect(first - second).toBeCloseTo(
      wagonNoseDistance(1000, 1) - wagonNoseDistance(1000, 2),
    );
  });
});
