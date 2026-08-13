import { describe, expect, it } from "vitest";
import { CONTAINER, CRANE, GANTRY } from "./config";
import {
  CRANE_CYCLE,
  assignCrane,
  createCrane,
  releaseCrane,
  spreaderZ,
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
  it("reports nothing and works no leg when it has no train to serve", () => {
    const crane = createCrane(createRng(1), 800, 240);
    expect(stepCrane(crane, 20, TARGET)).toBeNull();
    expect(crane.legIndex).toBe(0);
  });

  it("hoists clear and goes home when it is released mid-cycle", () => {
    /*
     * The direct regression test for "the idle crane's magnet is on the ground — trains go
     * through it". Release happens on the frame the last box lands, which is one leg before
     * the lift, so an idle crane used to sit with its spreader at deck height straight
     * across a running line. Idling is a movement now, not a `return`.
     */
    const crane = createCrane(createRng(1), 800, 240);
    assignCrane(crane, "train-0", "unload");
    until(crane, "closed");
    expect(crane.hoistZ).toBeLessThan(CRANE.TRAVEL_Z);
    releaseCrane(crane);

    // The lift comes first: crossing the yard at deck height is how you take the top off a
    // wagon, so the portal may not start moving until the hoist is up.
    const startedAt = crane.portalX;
    while (crane.hoistZ < CRANE.TRAVEL_Z) {
      stepCrane(crane, 20, TARGET);
      if (crane.hoistZ < CRANE.TRAVEL_Z) expect(crane.portalX).toBe(startedAt);
    }
    for (let index = 0; index < 2_000; index++) stepCrane(crane, 20, TARGET);
    expect(crane.hoistZ).toBe(CRANE.TRAVEL_Z);
    expect(crane.portalX).toBeCloseTo(crane.parkedX);
    expect(crane.trolleyY).toBeCloseTo(crane.parkedY);
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
    // The bottom of the pile is the ground, because `hoistZ` measures the box, not the
    // spreader — adding the spreader's own thickness here was half of the drop bug.
    expect(low.hoistZ).toBe(0);
  });

  it("grips at the same height it lets go at, on a wagon and on the stack", () => {
    /*
     * The regression test for "the crane drop moves past the wagon into the ground".
     *
     * `hoistZ` used to mean the spreader on some legs and the box on others: placing drove
     * to the bare deck while the renderer drew the carried box sixteen units *below* that,
     * which is z -6 — through the wagon and into the ballast. Taking a box off a wagon and
     * putting one back on it are the same plane, and saying so is what makes that
     * unexpressible rather than merely fixed.
     */
    const placing = createCrane(createRng(1), 800, 240);
    assignCrane(placing, "train-0", "load");
    until(placing, "opened");

    const taking = createCrane(createRng(1), 800, 240);
    assignCrane(taking, "train-0", "unload");
    until(taking, "closed");

    expect(placing.hoistZ).toBe(CONTAINER.deck);
    expect(taking.hoistZ).toBe(CONTAINER.deck);
  });

  it("keeps the spreader above the box it is carrying", () => {
    const crane = createCrane(createRng(1), 800, 240);
    assignCrane(crane, "train-0", "load");
    for (let index = 0; index < 4_000; index++) {
      stepCrane(crane, 20, TARGET);
      expect(spreaderZ(crane)).toBe(crane.hoistZ + CONTAINER.size[2]);
    }
    // And the whole assembly stays under the trolley the rope comes off.
    expect(spreaderZ(crane) + GANTRY.spreaderHeight).toBeLessThan(
      GANTRY.height - GANTRY.trolleyHeight,
    );
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
