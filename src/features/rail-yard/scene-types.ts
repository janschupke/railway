/**
 * What a scene may say: the shape of the yard document, with no yard in it.
 *
 * Split from the instance because four of the five modules that import from here take
 * **types only** — the graph builder, the view, the renderer and the simulation all want
 * `Road`, `SceneNode` or `SceneStructure`, and every one of them was pulling a
 * three-hundred-line data literal into its module graph to get them.
 *
 * The three rules the instance is held to are stated where the instance is, since they are
 * properties of that yard rather than of the schema.
 */

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
