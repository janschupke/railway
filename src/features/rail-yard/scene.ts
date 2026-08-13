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
 * **One direction.** Every road carries traffic eastbound, and a train that runs off the
 * east side comes back on the west by a hidden return road. That single decision dissolves
 * a whole class of problem: no two trains can want the same track from opposite ends, so
 * head-on conflict and the deadlock that comes with it are not expressible, and the picture
 * reads left to right the way a diagram does.
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

/** Eastbound is the only sense. `hidden` track is off-camera and is not drawn. */
type RailStyle = "main" | "siding" | "hidden";

export type Road = {
  readonly id: string;
  /** Depth into the scene. 0 is nearest the camera. */
  readonly y: number;
  readonly span: readonly [west: number, east: number];
  readonly rail: RailStyle;
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
      readonly kind: "stack";
      /** West end and depth of the container stack's footprint. */
      readonly at: Vec2;
      readonly length: number;
      readonly depth: number;
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
};

const P = TRACK.ROAD_PITCH;

/**
 * Five roads, front to back, all eastbound.
 *
 * The running lines are nearest the camera because they carry the fastest movement and the
 * eye should get it first. The loading roads sit under one gantry so the crane can serve
 * either. The depot road runs *through* the shed at the back — through, not into, so a
 * locomotive enters one end and leaves the other and never has to reverse.
 *
 * Every road extends well past `extent`. That is what makes leaving the scene real travel
 * rather than a despawn: a departing train runs out of the frame on rails that continue,
 * and the depot road is long enough west of the shed to hold a second train queuing to get
 * in behind the first.
 */
const ROADS: readonly Road[] = [
  { id: "main-out", y: P * 0, span: [-1500, 3600], rail: "main" },
  { id: "main-in", y: P * 1, span: [-1500, 3600], rail: "main" },
  { id: "load-a", y: P * 2, span: [-900, 2100], rail: "siding" },
  { id: "load-b", y: P * 3, span: [-500, 1700], rail: "siding" },
  { id: "depot", y: P * 4, span: [-100, 900], rail: "siding" },
  /*
   * The return, which is the rest of the network.
   *
   * In front of the camera rather than behind it, and far enough in front that the
   * projection puts it below the bottom edge of the canvas at every scale. It has to be a
   * road of its own: a single edge joining the two staging nodes directly would be a
   * straight line from one side of the scene to the other, and a train on it would be drawn
   * running backwards across the middle of the yard. Which is precisely what it did.
   */
  { id: "return", y: -560, span: [-2200, 4000], rail: "hidden" },
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
    { id: "stage-east", road: "main-out", x: 3300, kind: "stage" },
    { id: "stage-west", road: "main-in", x: -1320, kind: "stage" },
    { id: "loop-east", road: "return", x: 3700, kind: "stage" },
    { id: "loop-west", road: "return", x: -1900, kind: "stage" },

    // The west throat: a ladder stepping down from the arrival line to the depot road.
    { id: "mi-far-w", road: "main-in", x: -1180, kind: "junction" },
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
    { id: "mi-w", road: "main-in", x: 460, kind: "junction" },
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
    { id: "x-main-in", road: "main-in", x: 2400, kind: "junction" },
    { id: "mo-e", road: "main-out", x: 2810, kind: "junction" },
  ],

  edges: [
    // The west throat, stepping down road by road to the shed.
    {
      id: "mi-to-la-far",
      from: "mi-far-w",
      to: "la-far-w",
      kind: "crossover",
      speed: 0.5,
    },
    {
      id: "la-to-lb-far",
      from: "la-far-w",
      to: "lb-far-w",
      kind: "crossover",
      speed: 0.45,
    },
    { id: "lb-to-dp-far", from: "lb-far-w", to: "dp-w", kind: "crossover", speed: 0.4 },
    { id: "dp-stand-in", from: "dp-w", to: "shed-road", kind: "run", speed: 0.3 },

    // Out of the shed, along the depot road and onto the loading road.
    { id: "dp-stand-out", from: "shed-road", to: "dp-e", kind: "run", speed: 0.32 },
    { id: "dp-to-lb", from: "dp-e", to: "lb-w", kind: "crossover", speed: 0.4 },
    { id: "lb-to-load", from: "lb-w", to: "lb-load", kind: "run", speed: 0.36 },
    { id: "lb-load-out", from: "lb-load", to: "lb-e", kind: "run", speed: 0.42 },

    // The east throat, up to the main line and away.
    { id: "lb-to-la-e", from: "lb-e", to: "x-load-a", kind: "crossover", speed: 0.5 },
    {
      id: "la-to-mi-e",
      from: "x-load-a",
      to: "x-main-in",
      kind: "crossover",
      speed: 0.62,
    },
    { id: "mi-to-mo-e", from: "x-main-in", to: "mo-e", kind: "crossover", speed: 0.78 },
    { id: "mo-away", from: "mo-e", to: "stage-east", kind: "run", speed: 1 },

    /*
     * The return: off the east end, round the front, and back on at the west.
     *
     * Three edges rather than one, and it matters. A single edge joining the two staging
     * nodes is a straight line right across the yard, and a train on it gets drawn running
     * backwards through the middle of the scene — which is what it did, at speed, straight
     * through the traffic. The loop road is far enough in front of the camera to be below
     * the bottom edge of the canvas, so a train on it is genuinely somewhere else.
     *
     * This is the only track in the yard that is not a piece of railway anyone can see, and
     * it exists so that no train is ever repositioned — which is what every one of the
     * vanishing defects came down to.
     */
    { id: "loop-out", from: "stage-east", to: "loop-east", kind: "hidden", speed: 4 },
    { id: "loop-round", from: "loop-east", to: "loop-west", kind: "hidden", speed: 4 },
    { id: "loop-in", from: "loop-west", to: "stage-west", kind: "hidden", speed: 4 },

    // Back in from the west, and along to the unloading road.
    { id: "mi-in", from: "stage-west", to: "mi-far-w", kind: "run", speed: 1 },
    { id: "mi-run", from: "mi-far-w", to: "mi-w", kind: "run", speed: 0.92 },
    { id: "mi-to-la", from: "mi-w", to: "la-w", kind: "crossover", speed: 0.5 },
    { id: "la-to-unload", from: "la-w", to: "la-unload", kind: "run", speed: 0.36 },
    { id: "la-unload-out", from: "la-unload", to: "la-e", kind: "run", speed: 0.42 },
    { id: "la-e-join", from: "la-e", to: "x-load-a", kind: "run", speed: 0.55 },
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
      height: 68,
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
      near: P * 2 - 32,
      far: P * 4 + 26,
      travel: [950, 1490],
    },
    /*
     * The yard stack, on open ground east of the depot road's end so the portal can reach
     * it without the trolley having to cross a running line. Containers come from here and
     * go back to here — they are never conjured onto a wagon.
     */
    { kind: "stack", at: [1250, P * 4], length: 46, depth: 20 },

    { kind: "signal", at: [670, P * 4 - 30], guards: "dp-to-lb" },
    { kind: "signal", at: [1550, P * 3 - 30], guards: "lb-to-la-e" },
    { kind: "signal", at: [1350, P * 2 - 30], guards: "la-e-join" },
    { kind: "signal", at: [430, P * 1 - 28], guards: "mi-to-la" },

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
      leaveVia: ["stage-east"],
      enterVia: ["stage-west"],
    },
  ],
};

/** The run a crossover between adjacent roads is authored at. Exported for the tests. */
export const CROSSOVER_RUN = LADDER_RUN;
