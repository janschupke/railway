/**
 * What the yard is, as data: one mutable record per moving thing, and the world holding
 * them.
 *
 * Split out of `simulation.ts` so that reading the shapes does not mean loading the rules.
 * `render.ts` wants `TrainState` and `WorldState` and nothing else — it used to reach for
 * them through the module that also owns the phase machine, the crane protocol and the
 * tick loop, which put the whole simulation in the renderer's type graph for two names.
 *
 * Everything here is mutable on purpose. The simulation steps a fixed grid and mutates in
 * place rather than rebuilding the world each tick; an immutable world at 50 Hz would
 * allocate the entire yard fifty times a second to change three numbers.
 */

import type { Conveyor, Freight } from "./conveyor";
import type { CraneState } from "./crane";
import type { Path, RailGraph } from "./graph";
import { rakeLength } from "./rake";
import type { Occupancy } from "./traffic";

/**
 * Two rings, not one.
 *
 * The first eight phases are a yard train's working day. The last three are an express's,
 * and it is a *train* rather than a duty for a reason: a through working that had to be
 * expressed as a duty would need a stop it does not make and a crane it does not use, and
 * every phase handler would grow a branch for the case where none of that applies.
 */
export type TrainPhase =
  | "idle"
  | "outbound"
  | "loading"
  | "hauling"
  | "away"
  | "inbound"
  | "unloading"
  | "homebound"
  | "waiting"
  | "running"
  | "returning";

export type Wagon = {
  /** What is standing on the flat, or null for an empty one. */
  cargo: Freight | null;
};

export type Itinerary = {
  readonly stable: string;
  readonly loadAt: string;
  readonly unloadAt: string;
  readonly leaveVia: string;
  readonly enterVia: string;
};

export type TrainState = {
  readonly id: string;
  readonly dutyId: string;
  /** Which ring this train goes round. The crane only ever looks at yard trains. */
  readonly kind: "yard" | "express";
  phase: TrainPhase;
  /** Never null. A train that cannot be seen is off-camera, not absent. */
  path: Path;
  distance: number;
  speed: number;
  timer: number;
  /** Containers the crane has finished with this visit. */
  handled: number;
  wagons: Wagon[];
  itinerary: Itinerary;
  blocked: boolean;
  sinceSmoke: number;
};

export type Puff = {
  x: number;
  y: number;
  /** Height. Smoke rises in z — adding it to depth would push it into the scene. */
  z: number;
  driftX: number;
  ageMs: number;
  readonly lifeMs: number;
};

export type WorldState = {
  readonly graph: RailGraph;
  elapsedMs: number;
  trains: TrainState[];
  crane: CraneState;
  conveyor: Conveyor;
  puffs: Puff[];
  occupancy: Occupancy;
};

export function trainLength(train: TrainState): number {
  return rakeLength(train.wagons.length);
}
