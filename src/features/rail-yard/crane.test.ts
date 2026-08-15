import { describe, expect, it } from "vitest";
import { CONVEYOR, CRANE } from "./config";
import { CONTAINER, GANTRY } from "./sprites";
import {
  CRANE_CYCLE,
  assignCrane,
  createCrane,
  releaseCrane,
  spreaderZ,
  stepCrane,
  type CraneState,
  type CraneTarget,
} from "./crane";

const TARGET: CraneTarget = {
  wagonX: 900,
  wagonY: 120,
  beltX: 1200,
  beltY: 240,
  exchangeReady: true,
};

/** Runs the crane until it reports an event or gives up, so a leg can be watched end to end. */
function until(
  crane: CraneState,
  event: "closed" | "opened",
  target: CraneTarget = TARGET,
  steps = 4_000,
): number {
  for (let index = 0; index < steps; index++) {
    if (stepCrane(crane, 20, target) === event) return index;
  }
  throw new Error(`crane never reported ${event}`);
}

describe("createCrane", () => {
  it("parks with an empty spreader, hoisted clear", () => {
    const crane = createCrane(800, 240);
    expect(crane.portalX).toBe(800);
    expect(crane.trolleyY).toBe(240);
    expect(crane.hoistZ).toBe(CRANE.TRAVEL_Z);
    expect(crane.holding).toBeNull();
    expect(crane.servingTrainId).toBeNull();
  });
});

describe("stepCrane", () => {
  it("reports nothing and works no leg when it has no train to serve", () => {
    const crane = createCrane(800, 240);
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
    const crane = createCrane(800, 240);
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
    const crane = createCrane(800, 240);
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
    const crane = createCrane(800, 240);
    assignCrane(crane, "train-0", "load");

    // Leg one is the portal running to the belt. Its x is the only thing that may move.
    const depth = crane.trolleyY;
    stepCrane(crane, 20, TARGET);
    expect(crane.portalX).toBeCloseTo(800 + (CRANE.PORTAL_SPEED * 20) / 1000);
    expect(crane.trolleyY).toBe(depth);

    while (crane.legIndex === 0) stepCrane(crane, 20, TARGET);
    expect(crane.portalX).toBeCloseTo(TARGET.beltX);
  });

  it("closes on the belt and opens over the wagon deck", () => {
    /*
     * The interlock the whole feature turns on: a container is only ever somewhere. The
     * crane reports the latch and the simulation does the accounting, because the
     * simulation is what owns the wagons — reading `holding` here was how a whole rake got
     * loaded with nothing.
     */
    const crane = createCrane(800, 240);
    assignCrane(crane, "train-0", "load");

    until(crane, "closed");
    expect(crane.trolleyY).toBeCloseTo(TARGET.beltY);
    expect(crane.hoistZ).toBe(CONVEYOR.DECK_Z);

    until(crane, "opened");
    expect(crane.portalX).toBeCloseTo(TARGET.wagonX);
    expect(crane.trolleyY).toBeCloseTo(TARGET.wagonY);
  });

  it("takes from the wagon and puts on the belt when it is unloading", () => {
    // One machine, source and sink exchanged. Two of them would be two things to keep in
    // step, and nine handlers would be nine functions each needing a test of its own.
    const crane = createCrane(800, 240);
    assignCrane(crane, "train-0", "unload");

    until(crane, "closed");
    expect(crane.portalX).toBeCloseTo(TARGET.wagonX);
    expect(crane.trolleyY).toBeCloseTo(TARGET.wagonY);

    until(crane, "opened");
    expect(crane.portalX).toBeCloseTo(TARGET.beltX);
    expect(crane.trolleyY).toBeCloseTo(TARGET.beltY);
  });

  it("waits above the belt rather than working a slot that is not ready", () => {
    /*
     * The belt's half of the interlock, and what makes "a container is never invented" a
     * property rather than an intention: with nothing settled in the head slot the crane
     * may not descend onto it, so it cannot close its jaws on empty air.
     */
    const waiting = { ...TARGET, exchangeReady: false };
    const crane = createCrane(800, 240);
    assignCrane(crane, "train-0", "load");

    // It runs the portal and the trolley across as usual, and then holds, high.
    for (let index = 0; index < 4_000; index++) stepCrane(crane, 20, waiting);
    expect(crane.portalX).toBeCloseTo(TARGET.beltX);
    expect(crane.trolleyY).toBeCloseTo(TARGET.beltY);
    expect(crane.hoistZ).toBe(CRANE.TRAVEL_Z);
    expect(crane.holding).toBeNull();

    // And picks the same cycle up where it left it once the belt is ready.
    expect(until(crane, "closed")).toBeGreaterThan(0);
  });

  it("never lifts the spreader above its travel height", () => {
    // Higher would put the hoist through the beam it hangs from.
    const crane = createCrane(800, 240);
    assignCrane(crane, "train-0", "load");
    for (let index = 0; index < 4_000; index++) {
      stepCrane(crane, 20, TARGET);
      expect(crane.hoistZ).toBeLessThanOrEqual(CRANE.TRAVEL_Z + 1e-9);
      expect(crane.hoistZ).toBeGreaterThanOrEqual(0);
    }
  });

  it("grips at the same height it lets go at, on a wagon and on the belt", () => {
    /*
     * The regression test for "the crane drop moves past the wagon into the ground".
     *
     * `hoistZ` used to mean the spreader on some legs and the box on others: placing drove
     * to the bare deck while the renderer drew the carried box sixteen units *below* that,
     * which is z -6 — through the wagon and into the ballast. Taking a box off a wagon and
     * putting one back on it are the same plane, and saying so is what makes that
     * unexpressible rather than merely fixed.
     */
    const placing = createCrane(800, 240);
    assignCrane(placing, "train-0", "load");
    until(placing, "opened");

    const taking = createCrane(800, 240);
    assignCrane(taking, "train-0", "unload");
    until(taking, "closed");

    expect(placing.hoistZ).toBe(CONTAINER.deck);
    expect(taking.hoistZ).toBe(CONTAINER.deck);
  });

  it("keeps the spreader above the box it is carrying", () => {
    const crane = createCrane(800, 240);
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
    const crane = createCrane(800, 240);
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
    const crane = createCrane(800, 240);
    assignCrane(crane, "train-1", "load");
    crane.holding = { colour: 2, ribs: 6 };
    releaseCrane(crane);
    expect(crane.servingTrainId).toBeNull();
    expect(crane.holding).toBeNull();
  });
});
