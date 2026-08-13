/**
 * The yard, as data.
 *
 * Three rules keep this honest.
 *
 * **World units, never pixels** — view.ts is the only file that knows what a pixel is.
 *
 * **Roads, not free points.** Every node names a road and takes its depth from it, so a
 * node cannot be authored a few units off its own track. Every edge is either a `run` along
 * one road or a `crossover` between two adjacent ones, and both are horizontal at their
 * ends — which is what makes junctions continuous by construction rather than by tuning.
 * The version this replaces carried hand-authored quadratic control points and left a 128.7
 * degree heading snap where two of them met, which a locomotive spun through in one frame.
 *
 * **One direction per road.** A road declares its `sense` and every piece of track along it
 * is worked that way, so no two trains can want the same rails from opposite ends: head-on
 * conflict and the deadlock that comes with it are not expressible. The yard itself is
 * entirely eastbound and reads left to right the way a diagram does; the one westbound road
 * is the front express line, which shares no track with anything.
 *
 * The throat is a **ladder** — a train climbing from the depot road to the main line steps
 * through each road in turn rather than cutting across them. Real yards are built this way
 * for the same reason this one is: a ladder has no diamonds in it, so there is no place two
 * trains can cross paths without one of them being on a piece of track the other wants, and
 * ordinary occupancy is enough to arbitrate the lot. scene.test.ts asserts that no two
 * edges intersect anywhere except at a shared node, which is what makes that a property of
 * the yard rather than a hope.
 */

import { TRACK } from "./config";
import type { NonEmpty } from "./rng";
import type { Vec2 } from "./geometry";

/** `hidden` track is off-camera and is not drawn. */
type RailStyle = "main" | "siding" | "hidden";

export type Road = {
  readonly id: string;
  /** Depth into the scene. 0 is nearest the camera. */
  readonly y: number;
  readonly span: readonly [west: number, east: number];
  readonly rail: RailStyle;
  /**
   * Which way this road is worked.
   *
   * Declared rather than inferred, and it is the whole of the deadlock argument: every
   * along-road edge must run this way, so two trains on one road are always going the same
   * way and a follower only ever waits for a train *ahead of it*. Two roads worked opposite
   * ways are two different roads, which is why the express lines are a pair.
   */
  readonly sense: "east" | "west";
};

type NodeKind = "stage" | "stop" | "junction";

export type SceneNode = {
  readonly id: string;
  readonly road: string;
  readonly x: number;
  readonly kind: NodeKind;
};

export type SceneEdge = {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: "run" | "crossover" | "hidden";
  /** Multiplier on YARD.BASE_SPEED. Crossovers and yard roads are slower than the main. */
  readonly speed: number;
};

export type SceneStructure =
  | {
      readonly kind: "shed";
      readonly road: string;
      /** West end and length along the road. */
      readonly at: number;
      readonly length: number;
      readonly depth: number;
      readonly height: number;
      readonly bays: number;
    }
  | {
      readonly kind: "gantry";
      /** Depths of the near and far legs, and the x range the portal can travel. */
      readonly near: number;
      readonly far: number;
      readonly travel: readonly [west: number, east: number];
    }
  | {
      readonly kind: "conveyor";
      /** The head, where the crane works the belt, and the belt's depth. */
      readonly at: Vec2;
      /** How far east the belt runs from its head. Far enough that its tail is off camera. */
      readonly length: number;
    }
  | { readonly kind: "signal"; readonly at: Vec2; readonly guards: string }
  | { readonly kind: "tower"; readonly at: Vec2; readonly size: Vec2 };

/**
 * One train's standing orders.
 *
 * Waypoints, not a route. The path between them is found in graph.ts, so adding a road
 * changes this file and nothing else — which is the whole reason the itineraries are not
 * written down as edge lists.
 */
export type Duty = {
  readonly id: string;
  readonly weight: number;
  readonly stable: NonEmpty<string>;
  readonly loadAt: NonEmpty<string>;
  readonly unloadAt: NonEmpty<string>;
  readonly leaveVia: NonEmpty<string>;
  readonly enterVia: NonEmpty<string>;
};

/**
 * A through working: one train, one road, and nothing to do in the yard.
 *
 * The bottom two roads exist to be run through rather than worked, and this is all that
 * takes. There is exactly one of these per express road and exactly one train per entry, so
 * "never more than one express on the line" is structural rather than a rule the simulation
 * has to keep. It waits at `holdAt`, runs to `runTo`, and comes back round the way it came
 * — all three on rails, none of it repositioned.
 */
type Express = {
  readonly id: string;
  /** Where it stands between runs. Hidden track, so waiting costs the yard nothing. */
  readonly holdAt: string;
  /** The far end of its run, likewise hidden — it leaves the frame before it stops. */
  readonly runTo: string;
};

export type RailScene = {
  /** The rectangle the camera frames. The roads deliberately run past it on both sides. */
  readonly extent: { readonly width: number; readonly height: number };
  /** The world x the camera centres on. */
  readonly focusX: number;
  /** World y at which sky meets ground. */
  readonly horizon: number;
  readonly roads: readonly Road[];
  readonly nodes: readonly SceneNode[];
  readonly edges: readonly SceneEdge[];
  readonly structures: readonly SceneStructure[];
  readonly duties: NonEmpty<Duty>;
  readonly expresses: readonly Express[];
};

const P = TRACK.ROAD_PITCH;

/**
 * Five roads, front to back.
 *
 * The two nearest the camera are express lines, worked in opposite directions and carrying
 * traffic that has no business in the yard at all. They are nearest because they carry the
 * fastest movement and the eye should get it first, and they run opposite ways because a
 * yard with everything going one way reads as a conveyor rather than as a railway. The
 * front one has no turnouts anywhere along it, which is what lets it be westbound without
 * touching the deadlock argument: it shares no rails with anything.
 *
 * Behind them the loading roads sit under one gantry so the crane can serve either, and the
 * depot road runs *through* the shed at the back — through, not into, so a locomotive
 * enters one end and leaves the other and never has to reverse.
 *
 * Every road extends well past `extent`. That is what makes leaving the scene real travel
 * rather than a despawn: a departing train runs out of the frame on rails that continue,
 * and the depot road is long enough west of the shed to hold a second train queuing to get
 * in behind the first.
 */
const ROADS: readonly Road[] = [
  { id: "express-west", y: P * 0, span: [-1200, 3200], rail: "main", sense: "west" },
  { id: "express-east", y: P * 1, span: [-1500, 3600], rail: "main", sense: "east" },
  { id: "load-a", y: P * 2, span: [-900, 2100], rail: "siding", sense: "east" },
  { id: "load-b", y: P * 3, span: [-500, 1700], rail: "siding", sense: "east" },
  { id: "depot", y: P * 4, span: [-100, 900], rail: "siding", sense: "east" },

  /*
   * Three hidden roads: the rest of the network, and where trains wait when they are
   * somewhere else.
   *
   * In front of the camera rather than behind it, and far enough in front that the
   * projection puts them below the bottom edge of the canvas at every scale. Each has to be
   * a road of its own — a single edge joining two staging nodes directly would be a straight
   * line from one side of the scene to the other, and a train on it would be drawn running
   * backwards across the middle of the yard, which is precisely what it did.
   *
   * One per circuit, rather than one shared. Two workings running opposite ways down the
   * same hidden road would be a head-on conflict that nobody could see and the occupancy
   * model would have to arbitrate — an invisible deadlock is still a deadlock, and the whole
   * point of a road having a sense is that it cannot happen.
   *
   * They are stacked, and the x at which each circuit dives off the yard is chosen so that
   * no two of these ever cross. Anything joining the yard to a road in front of it has to
   * pass *through* the westbound express line on the way, so the corridors are placed
   * outside the stretch of it a train ever occupies — which is what the staging nodes being
   * different distances out is for. scene.test.ts sweeps hidden track for crossings along
   * with everything else now, because leaving it out is how two of them came to converge on
   * the same point and run a train through another where nobody could see it.
   */
  { id: "west-loop", y: -240, span: [-900, 2400], rail: "hidden", sense: "east" },
  { id: "return", y: -560, span: [-2200, 4000], rail: "hidden", sense: "west" },
  { id: "east-loop", y: -380, span: [-1700, 3700], rail: "hidden", sense: "west" },
];

/**
 * How far every crossover runs along the roads while it steps across one.
 *
 * 410 against a pitch of 60 is a ratio of 6.8, which puts the steepest point of the curve
 * at about 1 in 5.4 — a yard turnout rather than a road junction. It is also why the throat
 * is well over a thousand units long: stepping four roads at this ratio costs 1640 units of
 * run, and a real ladder is exactly that stretched out. Shortening it is the one change
 * here that would make the track start looking wrong again.
 */
const LADDER_RUN = 410;

/**
 * What the express lines are worked at, as a multiple of `YARD.BASE_SPEED`.
 *
 * The whole of what an express is seen doing, so it is one number rather than four. At 3.2 it
 * crossed the frame quickly enough to read as a streak rather than as a train; 2.8 is 207
 * units a second, which is still three times what the yard's own traffic manages.
 *
 * The arrival and departure runs either side of it stay faster. They are the yard's own way
 * on and off the network, they are almost entirely off camera, and they are a pacing number:
 * a train dawdling out to the staging node is a train the frame is waiting on.
 */
const EXPRESS_SPEED = 2.8;

export const RAIL_YARD_SCENE: RailScene = {
  extent: { width: 1120, height: P * 4 },
  focusX: 940,
  horizon: 420,
  roads: ROADS,

  nodes: [
    /*
     * The staging nodes sit far outside `extent` — beyond the widest camera this page can
     * produce. Nothing special happens to a train there; it is simply somewhere nobody can
     * see, which is what "leaves the yard" has to mean if a departure is to read as
     * distance rather than as a despawn.
     */
    { id: "stage-east", road: "express-east", x: 3300, kind: "stage" },
    { id: "stage-west", road: "express-east", x: -1320, kind: "stage" },
    { id: "loop-east", road: "return", x: 3700, kind: "stage" },
    { id: "loop-west", road: "return", x: -1900, kind: "stage" },

    /*
     * The westbound express line and its own way back round. Two nodes on the road itself
     * and two on a loop of its own, which is the whole of it — no turnout anywhere.
     */
    { id: "xw-east", road: "express-west", x: 1900, kind: "junction" },
    { id: "xw-west", road: "express-west", x: -400, kind: "junction" },
    { id: "xw-hold", road: "west-loop", x: 2100, kind: "stage" },
    { id: "xw-back", road: "west-loop", x: -600, kind: "stage" },

    /*
     * And the eastbound express's, which shares the yard's own running line but waits on
     * track of its own, so a train standing between runs is never in the yard's way.
     *
     * `xe-enter` is why there are three of these rather than two. Bringing the express
     * straight onto `stage-west` gave it an approach that converged with the yard's own
     * return for the last five hundred units, and two trains on two different edges met in
     * the middle of it — the hidden twin of tracks laid over each other, and the traffic
     * model has nothing to arbitrate with until the rails actually meet at a node. Landing
     * it a hundred and twenty units short means the two approaches stay apart and the
     * junction is a junction.
     */
    { id: "xe-hold", road: "east-loop", x: -1400, kind: "stage" },
    { id: "xe-enter", road: "express-east", x: -800, kind: "junction" },
    { id: "xe-far", road: "east-loop", x: 3400, kind: "stage" },

    // The west throat: a ladder stepping down from the arrival line to the depot road.
    { id: "xe-far-w", road: "express-east", x: -1180, kind: "junction" },
    { id: "la-far-w", road: "load-a", x: -770, kind: "junction" },
    { id: "lb-far-w", road: "load-b", x: -360, kind: "junction" },

    // The depot road: in at the west, stand inside the shed, out at the east.
    { id: "dp-w", road: "depot", x: 50, kind: "junction" },
    { id: "shed-road", road: "depot", x: 560, kind: "stop" },
    { id: "dp-e", road: "depot", x: 700, kind: "junction" },

    // The loading road, worked eastbound: on at the west, stand under the gantry, off east.
    { id: "lb-w", road: "load-b", x: 1110, kind: "junction" },
    { id: "lb-load", road: "load-b", x: 1480, kind: "stop" },
    { id: "lb-e", road: "load-b", x: 1580, kind: "junction" },

    // The unloading road, likewise, reached from the arrival line further east.
    { id: "xe-w", road: "express-east", x: 460, kind: "junction" },
    { id: "la-w", road: "load-a", x: 870, kind: "junction" },
    { id: "la-unload", road: "load-a", x: 1280, kind: "stop" },
    { id: "la-e", road: "load-a", x: 1380, kind: "junction" },

    /*
     * The east throat, where both workings converge. A train that has just loaded and one
     * that has just unloaded both climb to the main line through `x-load-a`, so it is the
     * one place in the yard where two trains routinely contend for the same track — which
     * is the point. A yard with no conflict in it has nothing to simulate.
     */
    { id: "x-load-a", road: "load-a", x: 1990, kind: "junction" },
    { id: "x-express-e", road: "express-east", x: 2400, kind: "junction" },
  ],

  edges: [
    /*
     * The west throat, stepping down road by road to the shed.
     *
     * Worked at line speed rather than at yard speed, and every unit of it is west of the
     * frame. That is a pacing number rather than a look: a train takes the best part of a
     * minute to come down this ladder at shunting speed, all of it out of sight, and three
     * trains doing that at once is most of what "either a full queue or nothing on screen"
     * was. Nobody can see how fast a train takes a turnout nobody can see.
     */
    {
      id: "xe-to-la-far",
      from: "xe-far-w",
      to: "la-far-w",
      kind: "crossover",
      speed: 1,
    },
    {
      id: "la-to-lb-far",
      from: "la-far-w",
      to: "lb-far-w",
      kind: "crossover",
      speed: 0.95,
    },
    { id: "lb-to-dp-far", from: "lb-far-w", to: "dp-w", kind: "crossover", speed: 0.9 },
    { id: "dp-stand-in", from: "dp-w", to: "shed-road", kind: "run", speed: 0.3 },

    // Out of the shed, along the depot road and onto the loading road.
    { id: "dp-stand-out", from: "shed-road", to: "dp-e", kind: "run", speed: 0.32 },
    { id: "dp-to-lb", from: "dp-e", to: "lb-w", kind: "crossover", speed: 0.4 },
    { id: "lb-to-load", from: "lb-w", to: "lb-load", kind: "run", speed: 0.36 },
    { id: "lb-load-out", from: "lb-load", to: "lb-e", kind: "run", speed: 0.42 },

    // The east throat, up to the main line and away.
    { id: "lb-to-la-e", from: "lb-e", to: "x-load-a", kind: "crossover", speed: 0.5 },
    {
      id: "la-to-xe-e",
      from: "x-load-a",
      to: "x-express-e",
      kind: "crossover",
      speed: 0.62,
    },
    { id: "xe-away", from: "x-express-e", to: "stage-east", kind: "run", speed: 3.4 },

    /*
     * The return: off the east end, round the front, and back on at the west.
     *
     * Three edges rather than one, and it matters. A single edge joining the two staging
     * nodes is a straight line right across the yard, and a train on it gets drawn running
     * backwards through the middle of the scene — which is what it did, at speed, straight
     * through the traffic. The loop road is far enough in front of the camera to be below
     * the bottom edge of the canvas, so a train on it is genuinely somewhere else.
     *
     * This is track that is not a piece of railway anyone can see, and it exists so that no
     * train is ever repositioned — which is what every one of the vanishing defects came
     * down to.
     */
    { id: "loop-out", from: "stage-east", to: "loop-east", kind: "hidden", speed: 5 },
    { id: "loop-round", from: "loop-east", to: "loop-west", kind: "hidden", speed: 5 },
    { id: "loop-in", from: "loop-west", to: "stage-west", kind: "hidden", speed: 5 },

    // Back in from the west, along the running line and down to the unloading road. The
    // through run past `xe-w` is what makes this a main line rather than a dead end into a
    // turnout: an express uses the whole of it without touching the yard.
    { id: "xe-in", from: "stage-west", to: "xe-far-w", kind: "run", speed: 3.4 },
    {
      id: "xe-run",
      from: "xe-far-w",
      to: "xe-enter",
      kind: "run",
      speed: EXPRESS_SPEED,
    },
    { id: "xe-mid", from: "xe-enter", to: "xe-w", kind: "run", speed: EXPRESS_SPEED },
    {
      id: "xe-through",
      from: "xe-w",
      to: "x-express-e",
      kind: "run",
      speed: EXPRESS_SPEED,
    },
    { id: "xe-to-la", from: "xe-w", to: "la-w", kind: "crossover", speed: 0.5 },
    { id: "la-to-unload", from: "la-w", to: "la-unload", kind: "run", speed: 0.36 },
    { id: "la-unload-out", from: "la-unload", to: "la-e", kind: "run", speed: 0.42 },
    { id: "la-e-join", from: "la-e", to: "x-load-a", kind: "run", speed: 0.55 },

    /*
     * The westbound express line: one run the length of the scene, and a loop of its own.
     *
     * No turnout touches it anywhere, which is what makes running it the other way free.
     * Its loop is a separate road from the yard's for the same reason the yard's exists at
     * all — two circuits sharing hidden track in opposite senses is a head-on conflict
     * nobody can see, and an invisible deadlock is still a deadlock.
     */
    { id: "xw-run", from: "xw-east", to: "xw-west", kind: "run", speed: EXPRESS_SPEED },
    { id: "xw-drop", from: "xw-west", to: "xw-back", kind: "hidden", speed: 5 },
    { id: "xw-round", from: "xw-back", to: "xw-hold", kind: "hidden", speed: 5 },
    { id: "xw-launch", from: "xw-hold", to: "xw-east", kind: "hidden", speed: 5 },

    // And the eastbound express's way on and off the yard's running line.
    { id: "xe-launch", from: "xe-hold", to: "xe-enter", kind: "hidden", speed: 5 },
    { id: "xe-drop", from: "stage-east", to: "xe-far", kind: "hidden", speed: 5 },
    { id: "xe-round", from: "xe-far", to: "xe-hold", kind: "hidden", speed: 5 },
  ],

  structures: [
    /*
     * The engine shed straddles the depot road, with a doorway at each end. `shed-road` at
     * 580 stands a locomotive squarely inside it and leaves the wagons trailing out of the
     * west door onto the road behind — which is what a depot looks like, and what makes a
     * train that has gone home read as being *in* a building rather than parked in front of
     * one. The renderer splits the front wall out of the static layer for exactly this.
     */
    {
      kind: "shed",
      road: "depot",
      at: 380,
      length: 220,
      depth: 74,
      // Tall enough that the lintel over a 64-unit doorway is still a lintel. See
      // SHED.doorHeight for why the doorway is measured against the screen rather than
      // against the locomotive.
      height: 82,
      bays: 2,
    },
    /*
     * One portal straddling both loading roads and reaching back to the yard stack.
     *
     * Its travel has to cover the longest rake at either stop. Five wagons behind a
     * locomotive is 62 + 5 x 51 = 317 units, so a train standing at 1340 reaches back to
     * 1023 and one at 1140 reaches back to 823. scene.test.ts checks both against this
     * range rather than trusting the arithmetic here.
     */
    {
      kind: "gantry",
      // The near leg stands clear of the eastbound express's ballast rather than on the
      // edge of it — that road carries the fastest thing in the scene now.
      near: P * 2 - 22,
      far: P * 4 + 26,
      travel: [950, 1490],
    },
    /*
     * The conveyor, on open ground east of the depot road's end so the portal can reach its
     * head without the trolley having to cross a running line.
     *
     * It runs *east*, out of the frame. That is the point of it: the pile it replaces had no
     * way in and no way out, so the simulation invented containers at one end and destroyed
     * them at the other. Freight rides in from off camera and rides back out the same way,
     * and the only boundary the yard has with the world outside it is one nobody can see.
     */
    { kind: "conveyor", at: [1230, P * 4], length: 670 },

    { kind: "signal", at: [670, P * 4 - 30], guards: "dp-to-lb" },
    { kind: "signal", at: [1550, P * 3 - 30], guards: "lb-to-la-e" },
    { kind: "signal", at: [1350, P * 2 - 30], guards: "la-e-join" },
    { kind: "signal", at: [430, P * 1 - 28], guards: "xe-to-la" },

    // The skyline stands on the horizon. Irregular on purpose: evenly spaced blocks read as
    // a fence, and the eye finds a repeat long before it finds a city.
    { kind: "tower", at: [200, 420], size: [58, 148] },
    { kind: "tower", at: [330, 420], size: [40, 196] },
    { kind: "tower", at: [440, 420], size: [52, 116] },
    { kind: "tower", at: [590, 420], size: [66, 172] },
    { kind: "tower", at: [700, 420], size: [44, 124] },
    { kind: "tower", at: [840, 420], size: [74, 100] },
    { kind: "tower", at: [980, 420], size: [48, 186] },
    { kind: "tower", at: [1110, 420], size: [62, 134] },
    { kind: "tower", at: [1260, 420], size: [42, 162] },
    { kind: "tower", at: [1390, 420], size: [68, 108] },
    { kind: "tower", at: [1530, 420], size: [54, 144] },
    { kind: "tower", at: [1660, 420], size: [46, 178] },
  ],

  duties: [
    /*
     * One duty, and every train works it.
     *
     * There is only one stabling road, so a second train arriving home while the first is
     * still in the shed queues behind it on the depot road and waits — which is a queue the
     * traffic model produces rather than one this file has to describe. Adding a second
     * duty is a matter of naming different stops, not of touching anything else.
     */
    {
      id: "yard-freight",
      weight: 1,
      stable: ["shed-road"],
      loadAt: ["lb-load"],
      unloadAt: ["la-unload"],
      /*
       * A train that has hauled away waits on the *hidden* road rather than at the end of
       * the running line. Both are off camera, so it makes no difference to the picture —
       * and all the difference to the traffic, because the running line is what the
       * eastbound express uses to get through. A train parked at the end of it is a train
       * standing in the express's way for the whole of its dwell.
       */
      leaveVia: ["loop-east"],
      enterVia: ["stage-west"],
    },
  ],

  /*
   * One through working per express road, and exactly one train per working.
   *
   * That is what makes "never more than one express on the line" structural: there is no
   * rule anywhere that enforces it, because there is nothing that could produce a second.
   */
  expresses: [
    { id: "express-west", holdAt: "xw-hold", runTo: "xw-west" },
    { id: "express-east", holdAt: "xe-hold", runTo: "xe-far" },
  ],
};

/** The run a crossover between adjacent roads is authored at. Exported for the tests. */
export const CROSSOVER_RUN = LADDER_RUN;
