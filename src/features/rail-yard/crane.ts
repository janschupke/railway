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
 * timestep as the trains, so a container is only ever somewhere — on the belt, in the
 * spreader, or on a wagon — and you watch it make the journey between them.
 *
 * The cycle is **one** ten-leg machine rather than two of eleven. Loading and unloading are
 * the same moves with the source and the sink exchanged, which is both true to the machine
 * and what keeps the feature's 98% function-coverage floor reachable: nine handlers would
 * be nine functions each needing a test of its own.
 */

import { CONTAINER, CONVEYOR, CRANE, LOCOMOTIVE, WAGON, YARD } from "./config";

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
  /** Where the portal and trolley stand when there is nothing to serve. */
  readonly parkedX: number;
  readonly parkedY: number;
};

/**
 * Where the crane must be to do its work, told to it because only the simulation knows.
 *
 * `exchangeReady` is the belt's half of the interlock: a box settled in the head slot when
 * the crane has come to take one, and a clear slot when it has come to set one down. The
 * crane holds on the leg that would work the belt until it is true, which is what keeps a
 * container from being lifted out of thin air or lowered onto one already standing there.
 */
export type CraneTarget = {
  readonly wagonX: number;
  readonly wagonY: number;
  readonly beltX: number;
  readonly beltY: number;
  readonly exchangeReady: boolean;
};

export function createCrane(parkedX: number, parkedY: number): CraneState {
  return {
    portalX: parkedX,
    trolleyY: parkedY,
    hoistZ: CRANE.TRAVEL_Z,
    holding: null,
    legIndex: 0,
    timer: 0,
    servingTrainId: null,
    wagonIndex: 0,
    direction: "load",
    parkedX,
    parkedY,
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
 * Whether a leg's `source`/`sink` is the belt rather than a wagon.
 *
 * Loading takes from the belt and gives to a wagon; unloading is the same machine with the
 * two exchanged. One expression, and it is why there are ten legs rather than twenty.
 */
const atBelt = (crane: CraneState, leg: CraneLeg): boolean =>
  leg.move !== "latch" && (leg.to === "source") === (crane.direction === "load");

/** Every leg that touches the belt: the descent onto it and the latch that follows. */
function worksBelt(crane: CraneState, leg: CraneLeg): boolean {
  if (leg.move === "latch") return leg.take === (crane.direction === "load");
  return leg.move === "z" && leg.to !== "travel" && atBelt(crane, leg);
}

function axisTarget(
  crane: CraneState,
  leg: CraneLeg,
  target: CraneTarget,
): number | null {
  const belt = atBelt(crane, leg);

  if (leg.move === "x") return belt ? target.beltX : target.wagonX;
  if (leg.move === "y") return belt ? target.beltY : target.wagonY;
  if (leg.move === "z") {
    if (leg.to === "travel") return CRANE.TRAVEL_Z;
    // One grip plane per place, whichever way the box is going — which is the whole point
    // of measuring the box's underside rather than the spreader's.
    return belt ? CONVEYOR.DECK_Z : CONTAINER.deck;
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

  /*
   * The belt's half of the interlock, and the reason a container is never invented.
   *
   * The crane holds *above* the belt rather than descending onto it, so it can neither
   * close on an empty slot nor lower a box onto one that is still occupied. Holding a leg
   * rather than letting it complete is what keeps the two machines honest with each other
   * without either of them reaching into the other's state.
   */
  if (!target.exchangeReady && worksBelt(crane, leg)) return null;

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
