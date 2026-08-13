/**
 * The yard, as data.
 *
 * Two rules keep this honest. World units, never pixels — view.ts is the only file that
 * knows what a pixel is. And the graph is pure topology: anything merely *drawn* (sheds,
 * the gantry, signals, the skyline) lives in `structures`, so graph.ts never has to know
 * what a shed is and adding one cannot change how a train routes.
 *
 * scene.test.ts validates every claim this file makes about itself — that edges name
 * declared nodes, that no anti-parallel pair exists, that every duty's whole cycle has a
 * path. A yard that cannot be driven is a red test, not a blank canvas.
 */

import type { NonEmpty } from "./rng";
import type { Vec2 } from "./geometry";

type NodeKind = "depot" | "bay" | "siding" | "junction" | "exit";

export type SceneNode = {
  readonly id: string;
  readonly at: Vec2;
  readonly kind: NodeKind;
};

/** A quadratic control point, absolute — it is what the literal reads best as. */
type EdgeShape =
  { readonly type: "straight" } | { readonly type: "curve"; readonly via: Vec2 };

/** How the permanent way is painted. `hidden` is the run past the camera's edge. */
type RailStyle = "main" | "siding" | "hidden";

export type SceneEdge = {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly shape: EdgeShape;
  readonly rail: RailStyle;
  /** Multiplier on YARD.BASE_SPEED. Curves and yard roads are slower than the main. */
  readonly speed: number;
};

export type SceneStructure =
  | {
      readonly kind: "shed";
      readonly at: Vec2;
      readonly size: Vec2;
      readonly bays: number;
    }
  | { readonly kind: "gantry"; readonly at: Vec2; readonly span: number }
  | { readonly kind: "signal"; readonly at: Vec2; readonly guards: string }
  | { readonly kind: "tower"; readonly at: Vec2; readonly size: Vec2 };

/**
 * One train's standing orders.
 *
 * Waypoints, not a route. The path between them is found in graph.ts, so adding a siding
 * changes this file and nothing else — which is the whole reason the itineraries are not
 * written down as edge lists.
 */
export type Duty = {
  readonly id: string;
  readonly weight: number;
  readonly home: NonEmpty<string>;
  readonly loadAt: NonEmpty<string>;
  readonly exitVia: NonEmpty<string>;
  readonly enterVia: NonEmpty<string>;
  readonly wagons: readonly [min: number, max: number];
};

export type RailScene = {
  readonly extent: { readonly width: number; readonly height: number };
  /** The world x the camera centres on. The bay, so the busy half is never cropped. */
  readonly focusX: number;
  /** World y at which sky meets ground. */
  readonly horizon: number;
  readonly nodes: readonly SceneNode[];
  readonly edges: readonly SceneEdge[];
  readonly structures: readonly SceneStructure[];
  readonly duties: NonEmpty<Duty>;
};

/**
 * Three parallel roads — the main line at y = 0, the loading road at y = 62, the depot
 * fan at y = 124 — wired as a directed **loop**:
 *
 *   depot → throat → bay-west → bay road → bay-east → main-east → exit-east
 *   exit-west → main-west → bay-west          (the return working)
 *   bay-east → siding → depot                 (stabling)
 *
 * The loop is load-bearing rather than decorative. Because every edge is directed and no
 * two edges connect the same pair in opposite senses, two trains can never want the same
 * piece of track from opposite ends — so head-on conflict, and with it deadlock, is
 * impossible by the shape of this literal rather than by anything simulation.ts does.
 * scene.test.ts asserts that shape.
 */
export const RAIL_YARD_SCENE: RailScene = {
  /*
   * The roads are spread far wider apart in y than a plan view would put them, and the
   * horizon sits well above the yard. The first version used a third of these numbers
   * and rendered as a hundred-pixel ribbon pinned to the bottom edge with the sheds
   * floating clear of their own tracks — a rail yard is inherently wide and short, so
   * the vertical separation has to be exaggerated for it to read as depth at all.
   */
  extent: { width: 1200, height: 420 },
  focusX: 560,
  horizon: 300,

  nodes: [
    /*
     * The exits sit outside `extent` on purpose. Nothing special happens to a train
     * there — it runs off the side of the camera, which is what "leaves the scene" has
     * to mean if the departure is to read as distance rather than as a despawn.
     */
    { id: "exit-west", at: [-190, 0], kind: "exit" },
    { id: "exit-east", at: [1390, 0], kind: "exit" },

    { id: "depot-north", at: [110, 124], kind: "depot" },
    { id: "depot-south", at: [130, 62], kind: "depot" },
    { id: "throat", at: [300, 62], kind: "junction" },
    { id: "main-west", at: [300, 0], kind: "junction" },
    { id: "main-east", at: [860, 0], kind: "junction" },
    { id: "bay-west", at: [470, 62], kind: "bay" },
    { id: "bay-east", at: [700, 62], kind: "bay" },
    { id: "siding", at: [560, 124], kind: "siding" },
  ],

  edges: [
    {
      id: "dn-throat",
      from: "depot-north",
      to: "throat",
      shape: { type: "curve", via: [235, 124] },
      rail: "siding",
      speed: 0.45,
    },
    {
      id: "ds-throat",
      from: "depot-south",
      to: "throat",
      shape: { type: "straight" },
      rail: "siding",
      speed: 0.5,
    },
    {
      id: "throat-bay",
      from: "throat",
      to: "bay-west",
      shape: { type: "straight" },
      rail: "siding",
      speed: 0.6,
    },
    /*
     * The loading road: the one edge both halves of the cycle traverse, and therefore
     * the only one the headway rule ever has real work to do on.
     */
    {
      id: "bay-road",
      from: "bay-west",
      to: "bay-east",
      shape: { type: "straight" },
      rail: "siding",
      speed: 0.35,
    },
    {
      id: "bay-main",
      from: "bay-east",
      to: "main-east",
      shape: { type: "curve", via: [812, 62] },
      rail: "main",
      speed: 0.8,
    },
    /*
     * The runs to the exits are drawn, not hidden. Left undrawn they made the outer
     * third of a desktop viewport empty ground with trains sliding across it on nothing,
     * and the departure read as a glitch rather than as leaving. The rails simply run
     * past the camera and are clipped, which is what makes the exits look like distance.
     */
    {
      id: "main-out",
      from: "main-east",
      to: "exit-east",
      shape: { type: "straight" },
      rail: "main",
      speed: 1,
    },
    {
      id: "main-in",
      from: "exit-west",
      to: "main-west",
      shape: { type: "straight" },
      rail: "main",
      speed: 1,
    },
    {
      id: "main-bay",
      from: "main-west",
      to: "bay-west",
      shape: { type: "curve", via: [396, 7] },
      rail: "main",
      speed: 0.7,
    },
    {
      id: "bay-siding",
      from: "bay-east",
      to: "siding",
      shape: { type: "curve", via: [664, 107] },
      rail: "siding",
      speed: 0.4,
    },
    /*
     * Both depot roads leave the siding. Without the second one depot-south has no
     * in-edge at all: it is reachable on a map but not by a train, so a duty that homes
     * there can go out and never come back. scene.test.ts asserts every duty's whole
     * cycle has a path, which is the assertion that found it.
     */
    {
      id: "siding-dn",
      from: "siding",
      to: "depot-north",
      shape: { type: "curve", via: [330, 150] },
      rail: "siding",
      speed: 0.45,
    },
    {
      id: "siding-ds",
      from: "siding",
      to: "depot-south",
      shape: { type: "curve", via: [346, 90] },
      rail: "siding",
      speed: 0.42,
    },
  ],

  structures: [
    // The engine shed stands on the depot road; the store behind it is further back and
    // is hazed for it. Both sit on their own ground line, not on the track's.
    { kind: "shed", at: [22, 124], size: [152, 62], bays: 2 },
    { kind: "shed", at: [204, 208], size: [98, 48], bays: 1 },
    { kind: "gantry", at: [470, 62], span: 230 },
    { kind: "signal", at: [352, 31], guards: "throat-bay" },
    { kind: "signal", at: [744, 22], guards: "bay-main" },
    { kind: "signal", at: [330, 2], guards: "main-bay" },
    // The skyline stands on the horizon. Irregular on purpose: five evenly spaced blocks
    // read as a fence, and the eye finds a repeat long before it finds a city.
    { kind: "tower", at: [128, 300], size: [58, 148] },
    { kind: "tower", at: [238, 300], size: [40, 196] },
    { kind: "tower", at: [326, 300], size: [52, 116] },
    { kind: "tower", at: [452, 300], size: [66, 172] },
    { kind: "tower", at: [546, 300], size: [44, 124] },
    { kind: "tower", at: [672, 300], size: [74, 100] },
    { kind: "tower", at: [788, 300], size: [48, 186] },
    { kind: "tower", at: [902, 300], size: [62, 134] },
    { kind: "tower", at: [1024, 300], size: [42, 162] },
    { kind: "tower", at: [1132, 300], size: [68, 108] },
  ],

  duties: [
    {
      id: "east-freight",
      weight: 3,
      home: ["depot-south", "depot-north"],
      loadAt: ["bay-west"],
      exitVia: ["exit-east"],
      enterVia: ["exit-west"],
      wagons: [4, 6],
    },
    {
      id: "yard-shunt",
      weight: 1,
      home: ["depot-north"],
      loadAt: ["bay-west"],
      exitVia: ["exit-east"],
      enterVia: ["exit-west"],
      wagons: [2, 3],
    },
  ],
};
