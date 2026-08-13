/**
 * The travelling gantry crane, as simulation rather than as decoration.
 *
 * The previous version had a hoist that was a rectangle parked at mid-span. It never moved,
 * it was not connected to anything, and containers simply appeared on wagons one per 900 ms
 * — which is what "containers appearing and disappearing suddenly" was. Worse, the gantry
 * spanned *east* of the loading stop while a rake extends *west*, so the boxes materialised
 * on wagons that were nowhere near it.
 *
 * This is the same machine a real yard has, with three visible degrees of freedom: the
 * portal runs along the roads in x, the trolley runs across the beam in y, and the hoist
 * runs in z. Every one of them is a position in the world, stepped by the same fixed
 * timestep as the trains, so a container is only ever somewhere — on the stack, in the
 * spreader, or on a wagon — and you watch it make the journey between them.
 *
 * The cycle is **one** ten-leg machine rather than two of eleven. Loading and unloading are
 * the same moves with the source and the sink exchanged, which is both true to the machine
 * and what keeps the feature's 98% function-coverage floor reachable: nine handlers would
 * be nine functions each needing a test of its own.
 */

import { CONTAINER, CRANE, LOCOMOTIVE, WAGON, YARD } from "./config";
import { FREIGHT_TOKENS } from "./palette";
import type { Rng } from "./rng";

type Place = "source" | "sink";

export type CraneLeg =
  | { readonly move: "x"; readonly to: Place }
  | { readonly move: "y"; readonly to: Place }
  | { readonly move: "z"; readonly to: Place | "travel" }
  | { readonly move: "latch"; readonly take: boolean };

/**
 * Approach, drop, lock on, lift, traverse, lower, let go, lift clear.
 *
 * The portal moves before the trolley on purpose: a real gantry runs its long travel first
 * and cross-travels at the end, and doing it the other way round makes the spreader swing
 * out over the running lines on the way past.
 */
export const CRANE_CYCLE: readonly CraneLeg[] = [
  { move: "x", to: "source" },
  { move: "y", to: "source" },
  { move: "z", to: "source" },
  { move: "latch", take: true },
  { move: "z", to: "travel" },
  { move: "x", to: "sink" },
  { move: "y", to: "sink" },
  { move: "z", to: "sink" },
  { move: "latch", take: false },
  { move: "z", to: "travel" },
];

export type CraneState = {
  portalX: number;
  trolleyY: number;
  /**
   * The z of the **underside of the box the spreader is holding, or would hold**.
   *
   * One meaning, and it is the fix for "the crane drops a container through the wagon into
   * the ground". This used to be the spreader's own height on some legs and the box's on
   * others: `deckZ(false)` returned the wagon deck while the renderer drew the carried box
   * from `hoistZ - 16`, so setting a box down drove it to z -6. Picking one up and putting
   * it back in the same place are the same number now, which is what makes the old
   * asymmetry read as the bug it was rather than as a subtlety.
   */
  hoistZ: number;
  /** The freight colour index in the spreader, between the two latches and never else. */
  holding: number | null;
  legIndex: number;
  timer: number;
  /** The train being served, and which of its wagons. Null when the crane is idle. */
  servingTrainId: string | null;
  wagonIndex: number;
  direction: "load" | "unload";
  /** The yard stack, oldest first. Containers come from here and go back to here. */
  stack: number[];
  /** Where the portal and trolley stand when there is nothing to serve. */
  readonly parkedX: number;
  readonly parkedY: number;
};

/** Where the crane must be to work a wagon: told to it, because only the sim knows. */
export type CraneTarget = {
  readonly wagonX: number;
  readonly wagonY: number;
  readonly stackX: number;
  readonly stackY: number;
};

export function createCrane(rng: Rng, parked: number, stackAt: number): CraneState {
  /*
   * Opening stock, and never more than the stack holds.
   *
   * Seeding past capacity was a real bug with a knock-on: `stackTopZ` measures from however
   * many boxes are actually piled up, so an overfull stack sent the spreader *above* the
   * beam it hangs from on the very first lift.
   */
  const stack: number[] = [];
  for (
    let index = 0;
    index < Math.min(CRANE.STACK_FLOOR, CRANE.STACK_CAPACITY);
    index++
  ) {
    stack.push(Math.floor(rng() * FREIGHT_TOKENS.length));
  }
  return {
    portalX: parked,
    trolleyY: stackAt,
    hoistZ: CRANE.TRAVEL_Z,
    holding: null,
    legIndex: 0,
    timer: 0,
    servingTrainId: null,
    wagonIndex: 0,
    direction: "load",
    stack,
    parkedX: parked,
    parkedY: stackAt,
  };
}

/**
 * The z the spreader itself sits at: one container above the grip plane.
 *
 * Exported so the renderer draws it in the place the crane reaches to, rather than deriving
 * the same relationship a second time and letting the two drift — which is exactly how the
 * spreader came to be drawn *below* the box it was carrying.
 */
export function spreaderZ(crane: CraneState): number {
  return crane.hoistZ + CONTAINER.size[2];
}

/**
 * Which column and how high the box the crane is about to handle sits.
 *
 * Taking means the top of the pile — the last box put down. Placing means the slot after
 * it. Exported because the renderer has to draw the stack in exactly the same places the
 * crane reaches for, and two implementations of that would drift.
 */
export function stackSlot(index: number): { column: number; level: number } {
  const at = Math.max(0, index);
  return {
    column: Math.min(CRANE.STACK_COLUMNS - 1, Math.floor(at / CRANE.STACK_ROWS)),
    level: at % CRANE.STACK_ROWS,
  };
}

const handling = (crane: CraneState, taking: boolean): number =>
  taking ? crane.stack.length - 1 : crane.stack.length;

/**
 * The grip plane over the stack: the underside of the box being handled.
 *
 * Taking is the box already on top of the pile, placing is the slot above it, and the level
 * arithmetic is the renderer's — a stack box at level L is drawn from `L * STACK_STEP_Z`,
 * so that is what the crane reaches to. The spreader's own thickness used to be added in
 * here, which is what put the grip a spreader too high on every lift off the pile.
 */
function stackGripZ(crane: CraneState, taking: boolean): number {
  return stackSlot(handling(crane, taking)).level * CRANE.STACK_STEP_Z;
}

function axisTarget(
  crane: CraneState,
  leg: CraneLeg,
  target: CraneTarget,
): number | null {
  const loading = crane.direction === "load";
  const atStack = leg.move !== "latch" && (leg.to === "source") === loading;

  if (leg.move === "x") {
    if (!atStack) return target.wagonX;
    const taking = leg.to === "source" ? loading : !loading;
    return (
      target.stackX + stackSlot(handling(crane, taking)).column * CRANE.STACK_PITCH_X
    );
  }
  if (leg.move === "y") return atStack ? target.stackY : target.wagonY;
  if (leg.move === "z") {
    if (leg.to === "travel") return CRANE.TRAVEL_Z;
    // A wagon's grip plane is its deck whichever way the box is going, which is the whole
    // point of measuring the box's underside rather than the spreader's.
    return atStack ? stackGripZ(crane, leg.to === "source") : CONTAINER.deck;
  }
  return null;
}

/** Moves one value toward another at a rate, reporting whether it arrived. */
function approach(
  from: number,
  to: number,
  rate: number,
  seconds: number,
): [number, boolean] {
  const step = rate * seconds;
  const gap = to - from;
  if (Math.abs(gap) <= step) return [to, true];
  return [from + Math.sign(gap) * step, false];
}

/**
 * What the spreader just did, if anything.
 *
 * The crane reports the event and the simulation does the accounting, because the simulation
 * is what owns the wagons. Doing it here meant reading `holding` a line after it had been
 * cleared, which quietly loaded a whole rake with nothing — and it made the total number of
 * boxes in the yard drop by two in one step when a full stack coincided with a wagon being
 * emptied. Keeping the two apart is also what lets this file be tested without a world.
 */
export type CraneEvent = "closed" | "opened" | null;

/**
 * Where the crane stands when it has nothing to serve: hoist up, then home.
 *
 * Not a no-op, which is what it used to be. A crane released mid-cycle simply kept whatever
 * height the last leg left it at — and release happens on the frame the last box lands, one
 * leg before the lift, so it sat with the spreader at deck height directly over a running
 * line and trains drove through it. The lift comes first and the travel waits on it, for
 * the same reason a real gantry hoists before it moves: crossing the yard at deck height is
 * how you take the top off a wagon.
 */
function park(crane: CraneState, seconds: number): void {
  const [lifted, clear] = approach(
    crane.hoistZ,
    CRANE.TRAVEL_Z,
    CRANE.HOIST_SPEED,
    seconds,
  );
  crane.hoistZ = lifted;
  if (!clear) return;
  [crane.portalX] = approach(crane.portalX, crane.parkedX, CRANE.PORTAL_SPEED, seconds);
  [crane.trolleyY] = approach(
    crane.trolleyY,
    crane.parkedY,
    CRANE.TROLLEY_SPEED,
    seconds,
  );
}

/** Advances the crane by one step along its cycle. */
export function stepCrane(
  crane: CraneState,
  dtMs: number,
  target: CraneTarget,
): CraneEvent {
  const seconds = dtMs / 1000;
  if (crane.servingTrainId === null) {
    park(crane, seconds);
    return null;
  }

  const leg = CRANE_CYCLE[crane.legIndex] ?? CRANE_CYCLE[0]!;
  let done = false;
  let event: CraneEvent = null;

  if (leg.move === "latch") {
    crane.timer = Math.max(0, crane.timer - dtMs);
    if (crane.timer <= 0) {
      event = leg.take ? "closed" : "opened";
      done = true;
    }
  } else {
    const to = axisTarget(crane, leg, target);
    if (to !== null) {
      const rate =
        leg.move === "x"
          ? CRANE.PORTAL_SPEED
          : leg.move === "y"
            ? CRANE.TROLLEY_SPEED
            : CRANE.HOIST_SPEED;
      const current =
        leg.move === "x"
          ? crane.portalX
          : leg.move === "y"
            ? crane.trolleyY
            : crane.hoistZ;
      const [next, arrived] = approach(current, to, rate, seconds);
      if (leg.move === "x") crane.portalX = next;
      else if (leg.move === "y") crane.trolleyY = next;
      else crane.hoistZ = next;
      done = arrived;
    } else {
      done = true;
    }
  }

  if (!done) return null;

  crane.legIndex = (crane.legIndex + 1) % CRANE_CYCLE.length;
  const nextLeg = CRANE_CYCLE[crane.legIndex]!;
  crane.timer = nextLeg.move === "latch" ? CRANE.LATCH_MS : 0;
  return event;
}

/** Hands the crane a train to work. Restarting the cycle is what makes the first leg run. */
export function assignCrane(
  crane: CraneState,
  trainId: string,
  direction: CraneState["direction"],
): void {
  crane.servingTrainId = trainId;
  crane.direction = direction;
  crane.wagonIndex = 0;
  crane.legIndex = 0;
  crane.timer = 0;
  crane.holding = null;
}

export function releaseCrane(crane: CraneState): void {
  crane.servingTrainId = null;
  crane.holding = null;
  crane.legIndex = 0;
}

/**
 * The world x of the wagon the crane is working, measured back from a train's nose.
 *
 * The rake hangs *behind* the locomotive, so wagon `k` is a locomotive plus `k` wagons and
 * couplings back along the path. Getting this from the train rather than from a constant is
 * what makes the crane aim at a wagon that is actually there.
 */
export function wagonNoseDistance(noseDistance: number, index: number): number {
  return (
    noseDistance -
    LOCOMOTIVE.length -
    YARD.WAGON_GAP -
    index * (WAGON.length + YARD.WAGON_GAP)
  );
}
