/**
 * The scene's topology, indexed once, plus routing over it.
 *
 * Twenty edges makes Dijkstra overkill on performance and exactly right on coupling: no
 * itinerary is written down anywhere, so adding a road to scene.ts changes how trains route
 * without touching a line of this file or of simulation.ts. Routing runs a handful of times
 * per train per cycle — at dispatch, never per frame.
 *
 * This is also where a node stops being an id and becomes a position: it takes its depth
 * from the road it names, so a node cannot be authored a few units off its own track.
 */

import {
  poseAtDistance,
  sampleCrossover,
  sampleRun,
  type EdgeSamples,
  type Pose,
  type Vec2,
} from "./geometry";
import { VIEW } from "./config";
import type { RailScene, Road, SceneEdge, SceneNode } from "./scene-types";

type BuiltNode = SceneNode & { readonly at: Vec2; readonly rail: Road["rail"] };

type BuiltEdge = SceneEdge & {
  readonly samples: EdgeSamples;
  readonly length: number;
  /** The road an edge runs along, or the road it leaves for a crossover. */
  readonly road: string;
  readonly rail: Road["rail"];
};

export type RailGraph = {
  readonly scene: RailScene;
  readonly roads: ReadonlyMap<string, Road>;
  readonly nodes: ReadonlyMap<string, BuiltNode>;
  readonly edges: ReadonlyMap<string, BuiltEdge>;
  /** node id → the edges leaving it. Directed, so this is the whole adjacency. */
  readonly out: ReadonlyMap<string, readonly BuiltEdge[]>;
};

export type Path = {
  readonly edges: readonly string[];
  readonly length: number;
  /**
   * Cumulative arc length at the *end* of each edge, so a distance maps to an edge index by
   * search rather than by walking and subtracting.
   */
  readonly marks: readonly number[];
};

export function buildGraph(scene: RailScene): RailGraph {
  const roads = new Map(scene.roads.map((road) => [road.id, road]));
  const nodes = new Map<string, BuiltNode>();

  for (const node of scene.nodes) {
    const road = roads.get(node.road);
    // A node naming no road is a scene bug; scene.test.ts fails on it. Skipping keeps a
    // typo from taking the landing page down with it.
    if (!road) continue;
    nodes.set(node.id, { ...node, at: [node.x, road.y], rail: road.rail });
  }

  const edges = new Map<string, BuiltEdge>();
  const out = new Map<string, BuiltEdge[]>();

  for (const edge of scene.edges) {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (!from || !to) continue;

    const samples =
      edge.kind === "crossover"
        ? sampleCrossover(from.at, to.at, VIEW.EDGE_SAMPLES)
        : sampleRun(from.at, to.at);

    const built: BuiltEdge = {
      ...edge,
      samples,
      length: samples.length,
      road: from.road,
      // A crossover between a main line and a siding is drawn as the lighter of the two,
      // which is what a real connection into a yard looks like.
      rail:
        edge.kind === "hidden"
          ? "hidden"
          : from.rail === "main" && to.rail === "main"
            ? "main"
            : "siding",
    };
    edges.set(edge.id, built);

    const leaving = out.get(edge.from);
    if (leaving) leaving.push(built);
    else out.set(edge.from, [built]);
  }

  return { scene, roads, nodes, edges, out };
}

/**
 * The quickest way from one node to another, or null if there is none.
 *
 * Weighted by `length / speed` — travel *time*, not distance. Weighting by distance made
 * the slow depot road a shortcut whenever it was geometrically shorter, and trains took it
 * at a crawl in preference to the main line beside them.
 */
export function findPath(graph: RailGraph, from: string, to: string): Path | null {
  if (from === to) return { edges: [], length: 0, marks: [] };
  if (!graph.nodes.has(from) || !graph.nodes.has(to)) return null;

  const best = new Map<string, number>([[from, 0]]);
  const cameBy = new Map<string, BuiltEdge>();
  const settled = new Set<string>();

  for (;;) {
    let current: string | null = null;
    let currentCost = Infinity;
    for (const [node, cost] of best) {
      if (settled.has(node) || cost >= currentCost) continue;
      current = node;
      currentCost = cost;
    }
    if (current === null) return null;
    if (current === to) break;
    settled.add(current);

    for (const edge of graph.out.get(current) ?? []) {
      const cost = currentCost + edge.length / edge.speed;
      if (cost >= (best.get(edge.to) ?? Infinity)) continue;
      best.set(edge.to, cost);
      cameBy.set(edge.to, edge);
    }
  }

  const ids: string[] = [];
  let cursor = to;
  while (cursor !== from) {
    const edge = cameBy.get(cursor);
    // Unreachable while `to` is settled, but the type says otherwise and a silent infinite
    // loop is the worst possible reading of that.
    if (!edge) return null;
    ids.unshift(edge.id);
    cursor = edge.from;
  }

  const marks: number[] = [];
  let total = 0;
  for (const id of ids) {
    total += graph.edges.get(id)?.length ?? 0;
    marks.push(total);
  }

  return { edges: ids, length: total, marks };
}

/** The index of the edge holding `at`, clamped into the path at both ends. */
export function edgeIndexAt(path: Path, at: number): number {
  for (let index = 0; index < path.marks.length; index++) {
    if (at < path.marks[index]!) return index;
  }
  return Math.max(0, path.marks.length - 1);
}

/** The arc length at which an edge index starts, along the whole path. */
export function edgeStart(path: Path, index: number): number {
  return index === 0 ? 0 : (path.marks[index - 1] ?? 0);
}

/**
 * The pose at an arc length along a whole path.
 *
 * **Extrapolated** past both ends rather than clamped, because the geometry underneath it
 * is — see poseAtDistance. A rake's rear wagon is routinely at a negative distance while the
 * locomotive is still leaving the shed, and it is genuinely behind the first node rather
 * than on top of it. That single change is what stopped departing trains concertinaing into
 * a heap on the last rail before vanishing.
 */
export function poseAlong(graph: RailGraph, path: Path, at: number): Pose | null {
  if (path.edges.length === 0) return null;
  const index = edgeIndexAt(path, at);
  const edge = graph.edges.get(path.edges[index]!);
  if (!edge) return null;
  return poseAtDistance(edge.samples, at - edgeStart(path, index));
}
