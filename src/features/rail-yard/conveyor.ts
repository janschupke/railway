/**
 * The belt the yard's freight arrives on and leaves by.
 *
 * This replaces a pile of containers standing on open ground, and the pile is what two of
 * the reported defects came down to. It had no way in and no way out, so the simulation
 * invented a box at one end — `stack.pop() ?? Math.floor(rng() * FREIGHT_TOKENS.length)` —
 * and destroyed one at the other, silently, whenever it happened to be full. Containers
 * materialised from nothing and vanished into it, which is precisely what the whole feature
 * is supposed to make impossible.
 *
 * A belt gives the yard both ends, visibly. Freight rides in from off camera, queues where
 * the crane can reach it, and rides back out the same way. Nothing is created or destroyed
 * anywhere a visitor can see it happen.
 *
 * **Every box is on the ground.** That is worth more than the overflow fix on its own. A
 * pile coupled its own capacity to the height of the machine over it: the portal travels
 * *across* the stack on its way to it, so every box added to the pile pushed the carrying
 * height up and the whole gantry with it. A line has no such coupling — it grows sideways,
 * where there is nothing but yard.
 *
 * **One direction at a time, and the crane chooses it.** Loading a train means the head slot
 * must hold a box, so the belt feeds; unloading means the head slot must be free, so the
 * belt clears. That is the user-visible behaviour asked for — "making space for one when
 * unloading, pushing new ones when loading" — and it is why the direction is not a function
 * of the fill level. Fill-level hysteresis would have the belt feeding a box *into* the slot
 * the crane is about to set one down in.
 *
 * The direction changes once per train rather than once per frame, so there is nothing to
 * chatter and no hysteresis to tune.
 */

import { CONTAINER, CONVEYOR } from "./config";
import { FREIGHT_TOKENS } from "./palette";
import { rangeInt, type Rng } from "./rng";

/**
 * A container, as the yard tracks it: a livery and a panel count.
 *
 * Both belong to the **box**, which is the point. `ribs` used to be a property of the flat
 * wagon, so a container arrived on the belt with one corrugation and acquired another the
 * moment the crane set it down. The belt exists so that freight is something that travels
 * rather than something invented at each end, and a box that changes shape in transit is the
 * same defect a layer up.
 *
 * The colour is an index into `FREIGHT_TOKENS`, never a hex — this feature may not write a
 * colour any more than it may compute one.
 */
export type Freight = { readonly colour: number; readonly ribs: number };

export function createFreight(rng: Rng): Freight {
  return {
    colour: Math.floor(rng() * FREIGHT_TOKENS.length),
    ribs: rangeInt(rng, CONTAINER.ribs),
  };
}

/** One container riding the belt. `at` is a world x. */
type BeltBox = { readonly freight: Freight; at: number };

export type Conveyor = {
  /** Where the crane works the belt, and where the leading box comes to rest. */
  readonly headX: number;
  /** The far end, off camera at every viewport this page produces. */
  readonly tailX: number;
  readonly y: number;
  /** Head first — `boxes[0]` is the westmost, nearest the crane. */
  boxes: BeltBox[];
  running: "in" | "out";
};

/**
 * How many boxes fit between the head and the tail.
 *
 * Rounded **up**, because a slot counts if it is west of the tail rather than if a whole
 * pitch fits behind it — the last box on a full belt has the tail immediately behind it,
 * not a pitch behind it. Rounding down loses a slot, and the transient while a box rides
 * off the far end then reads as an overrun.
 */
export function capacityOf(conveyor: Conveyor): number {
  return Math.max(1, Math.ceil((conveyor.tailX - conveyor.headX) / CONVEYOR.PITCH));
}

/**
 * The x each box is heading for.
 *
 * Slots are a pitch apart from the head, and the head itself moves by one pitch when the
 * belt is clearing — which *is* the clearing. Making room for the crane to set a box down
 * and carrying the far end away are the same movement, so there is only one of them.
 */
function slotFor(conveyor: Conveyor, index: number): number {
  const head = conveyor.headX + (conveyor.running === "out" ? CONVEYOR.PITCH : 0);
  return head + index * CONVEYOR.PITCH;
}

/** A box is settled in the head slot and can be lifted off it. */
export function headLoaded(conveyor: Conveyor): boolean {
  const first = conveyor.boxes[0];
  return first !== undefined && first.at <= conveyor.headX + CONVEYOR.SETTLE;
}

/** The head slot is clear and the crane may set a box into it. */
export function headClear(conveyor: Conveyor): boolean {
  const first = conveyor.boxes[0];
  return (
    first === undefined || first.at >= conveyor.headX + CONVEYOR.PITCH - CONVEYOR.SETTLE
  );
}

/** Lifts the leading box off the belt. Null when there is nothing settled to lift. */
export function takeFromBelt(conveyor: Conveyor): Freight | null {
  if (!headLoaded(conveyor)) return null;
  return conveyor.boxes.shift()?.freight ?? null;
}

/** Sets a box into the head slot. Ignored when the slot is not clear, never stacked. */
export function putOnBelt(conveyor: Conveyor, freight: Freight): void {
  if (!headClear(conveyor)) return;
  conveyor.boxes.unshift({ freight, at: conveyor.headX });
}

/**
 * Advances the belt by one step.
 *
 * Every box runs toward its own slot at the same speed, which is what makes this a queue
 * rather than a train of boxes each waiting on the one in front: the slots are a pitch apart
 * and they are ordered, so a box that is behind can close up but can never overtake or
 * overlap. Two boxes cannot occupy the same place, by arithmetic rather than by a check.
 */
export function stepConveyor(conveyor: Conveyor, dtMs: number, rng: Rng): void {
  const step = (CONVEYOR.SPEED * dtMs) / 1000;

  for (let index = 0; index < conveyor.boxes.length; index++) {
    const box = conveyor.boxes[index]!;
    const slot = slotFor(conveyor, index);
    const gap = slot - box.at;
    box.at = Math.abs(gap) <= step ? slot : box.at + Math.sign(gap) * step;
  }

  if (conveyor.running === "in") {
    /*
     * Feeding. A box enters at the tail once the last one has moved a full pitch clear of
     * it, so the line never enters overlapping — and the belt is deliberately quicker than
     * the crane's cycle, which is the whole of "it always has containers".
     */
    const last = conveyor.boxes[conveyor.boxes.length - 1];
    const room = conveyor.boxes.length < capacityOf(conveyor);
    if (room && (last === undefined || last.at <= conveyor.tailX - CONVEYOR.PITCH)) {
      conveyor.boxes.push({ freight: createFreight(rng), at: conveyor.tailX });
    }
    return;
  }

  // Clearing. A box that has reached the tail has gone to the rest of the world, which is
  // off camera — the one boundary the yard is allowed to have, and it is out of sight.
  conveyor.boxes = conveyor.boxes.filter((box) => box.at < conveyor.tailX);
}

/**
 * A belt with freight already on it.
 *
 * Seeded at the slots rather than at the tail, because the world is warmed up by running the
 * real simulation and a belt that begins empty would have the first train waiting on it.
 */
export function createConveyor(
  rng: Rng,
  headX: number,
  tailX: number,
  y: number,
): Conveyor {
  const conveyor: Conveyor = { headX, tailX, y, boxes: [], running: "in" };
  const opening = Math.min(CONVEYOR.FLOOR, capacityOf(conveyor));
  for (let index = 0; index < opening; index++) {
    conveyor.boxes.push({ freight: createFreight(rng), at: slotFor(conveyor, index) });
  }
  return conveyor;
}
