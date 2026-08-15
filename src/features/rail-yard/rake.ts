/**
 * Where the vehicles in a train sit, measured back from its nose.
 *
 * One arrangement, and three modules used to reconstruct it from the same four operands:
 * the crane to decide where to aim, the renderer to decide where to draw, and the
 * simulation to decide how long the whole thing is. The crane's copy and the renderer's
 * were textually identical — same operands, same order, forty lines apart in different
 * files — so a change to `WAGON_GAP` moved the drawn wagon and the crane's aim
 * independently, and the failure would have looked like a crane bug rather than an
 * arithmetic one.
 *
 * There is nothing to keep in step now, which is the point: the rake belongs to neither
 * the machine that loads it nor the code that paints it.
 */

import { LOCOMOTIVE, WAGON, YARD } from "./config";

/**
 * Nose to nose between two adjacent wagons — a wagon plus the coupling behind it.
 *
 * The subexpression all three call sites had in common, named once so the next reader does
 * not have to work out whether the gap goes in front of a wagon or behind it.
 */
const WAGON_PITCH = WAGON.length + YARD.WAGON_GAP;

/**
 * The world distance of wagon `index`, given where the locomotive's nose is.
 *
 * The rake hangs *behind* the locomotive, so wagon `k` is a locomotive, a coupling and `k`
 * further wagon-and-coupling pitches back along the path. Deriving it from the train rather
 * than from a constant is what makes the crane aim at a wagon that is actually there.
 */
export function wagonNoseDistance(noseDistance: number, index: number): number {
  return noseDistance - LOCOMOTIVE.length - YARD.WAGON_GAP - index * WAGON_PITCH;
}

/**
 * How long a train with this many wagons is, end to end.
 *
 * The trailing `WAGON_GAP` is the coupling between the locomotive and the first wagon, and
 * it is conditional because a light engine has nothing to couple to.
 */
export function rakeLength(wagons: number): number {
  return LOCOMOTIVE.length + wagons * WAGON_PITCH + (wagons > 0 ? YARD.WAGON_GAP : 0);
}
