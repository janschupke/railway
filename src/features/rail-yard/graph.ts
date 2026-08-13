/**
 * The scene's topology, indexed once, plus routing over it.
 *
 * Ten edges makes Dijkstra overkill on performance and exactly right on coupling: no
 * itinerary is written down anywhere, so adding a siding to scene.ts changes how trains
 * route without touching a line of this file or of simulation.ts. Routing runs a handful
 * of times per train per cycle — at dispatch, never per frame.
 */

import { poseAtDistance, sampleEdge, type EdgeSamples, type Pose } from "./geometry";
import { VIEW } from "./config";
import type { RailScene, SceneEdge, SceneNode } from "./scene";

type BuiltEdge = SceneEdge & {
  readonly samples: EdgeSamples;
  readonly length: number;
};

export type RailGraph = {
  readonly scene: RailScene;
  readonly nodes: ReadonlyMap<string, SceneNode>;
  readonly edges: ReadonlyMap<string, BuiltEdge>;
  /** node id → the edges leaving it. Directed, so this is the whole adjacency. */
  readonly out: ReadonlyMap<string, readonly BuiltEdge[]>;
};

export type Path = {
  readonly edges: readonly string[];
  readonly length: number;
  /**
   * Cumulative arc length at the *end* of each edge, so a distance maps to an edge index
   * by search rather than by walking and subtracting.
   */
  readonly marks: readonly number[];
};

export function buildGraph(scene: RailScene): RailGraph {
  const nodes = new Map(scene.nodes.map((node) => [node.id, node]));
  const edges = new Map<string, BuiltEdge>();
  const out = new Map<string, BuiltEdge[]>();

  for (const edge of scene.edges) {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    // A dangling reference is a scene bug; scene.test.ts fails on it. Skipping keeps a
    // typo from taking the landing page down with it.
    if (!from || !to) continue;

    const samples = sampleEdge(
      from.at,
      to.at,
      edge.shape.type === "curve" ? edge.shape.via : null,
      VIEW.EDGE_SAMPLES,
    );
    const built: BuiltEdge = { ...edge, samples, length: samples.length };
    edges.set(edge.id, built);

    const leaving = out.get(edge.from);
    if (leaving) leaving.push(built);
    else out.set(edge.from, [built]);
  }

  return { scene, nodes, edges, out };
}

/**
 * The quickest way from one node to another, or null if there is none.
 *
 * Weighted by `length / speed` — travel *time*, not distance. Weighting by distance made
 * the slow depot road a shortcut whenever it was geometrically shorter, and trains took
 * it at a crawl in preference to the main line beside them.
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
  const marks: number[] = [];
  let cursor = to;
  while (cursor !== from) {
    const edge = cameBy.get(cursor);
    // Unreachable while `to` is settled, but the type says otherwise and a silent
    // infinite loop is the worst possible reading of that.
    if (!edge) return null;
    ids.unshift(edge.id);
    cursor = edge.from;
  }

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

/**
 * The pose at an arc length along a whole path.
 *
 * Clamped rather than extrapolated at both ends, because a rake's rear wagon is
 * routinely at a negative distance while the locomotive is still leaving the depot, and
 * its front wagon overruns the path end while the locomotive waits at the far signal.
 * Both should sit on the rails, not float off them.
 */
export function poseAlong(graph: RailGraph, path: Path, at: number): Pose | null {
  if (path.edges.length === 0) return null;
  const index = edgeIndexAt(path, at);
  const edge = graph.edges.get(path.edges[index]!);
  if (!edge) return null;
  const before = index === 0 ? 0 : path.marks[index - 1]!;
  return poseAtDistance(edge.samples, at - before);
}
