import { describe, expect, it } from "vitest";
import { buildGraph, edgeIndexAt, edgeStart, findPath, poseAlong } from "./graph";
import { RAIL_YARD_SCENE, type RailScene } from "./scene";

/**
 * A miniature yard: three roads, one run each, and a ladder between them. Small enough to
 * reason about by hand and shaped exactly like the real one.
 */
const TOY: RailScene = {
  extent: { width: 600, height: 100 },
  focusX: 300,
  horizon: 400,
  roads: [
    { id: "near", y: 0, span: [0, 900], rail: "main", sense: "east" },
    { id: "mid", y: 50, span: [0, 900], rail: "siding", sense: "east" },
    { id: "far", y: 100, span: [0, 900], rail: "siding", sense: "east" },
  ],
  nodes: [
    { id: "a", road: "far", x: 0, kind: "stop" },
    { id: "b", road: "far", x: 100, kind: "junction" },
    { id: "c", road: "mid", x: 400, kind: "junction" },
    { id: "d", road: "mid", x: 500, kind: "junction" },
    { id: "e", road: "near", x: 800, kind: "stop" },
  ],
  edges: [
    { id: "ab", from: "a", to: "b", kind: "run", speed: 0.5 },
    { id: "bc", from: "b", to: "c", kind: "crossover", speed: 0.5 },
    { id: "cd", from: "c", to: "d", kind: "run", speed: 1 },
    { id: "de", from: "d", to: "e", kind: "crossover", speed: 0.5 },
  ],
  structures: [],
  expresses: [],
  duties: [
    {
      id: "toy",
      weight: 1,
      stable: ["a"],
      loadAt: ["c"],
      unloadAt: ["d"],
      leaveVia: ["e"],
      enterVia: ["a"],
    },
  ],
};

const graph = buildGraph(TOY);

describe("buildGraph", () => {
  it("gives every node the depth of the road it names", () => {
    // A node cannot be authored a few units off its own track, because it carries no
    // depth of its own — this is what the scene's road model buys.
    expect(graph.nodes.get("a")?.at).toEqual([0, 100]);
    expect(graph.nodes.get("c")?.at).toEqual([400, 50]);
    expect(graph.nodes.get("e")?.at).toEqual([800, 0]);
  });

  it("measures a run as its chord and a crossover as longer", () => {
    expect(graph.edges.get("ab")?.length).toBeCloseTo(100);
    expect(graph.edges.get("bc")?.length).toBeGreaterThan(Math.hypot(300, 50));
  });

  it("indexes the edges leaving each node", () => {
    expect(graph.out.get("a")?.map((edge) => edge.id)).toEqual(["ab"]);
    expect(graph.out.get("e")).toBeUndefined();
  });

  it("draws a connection into a siding as siding track", () => {
    // A crossover off the main line into a yard is lighter track at the yard end, which
    // is what it looks like in life.
    expect(graph.edges.get("de")?.rail).toBe("siding");
    expect(graph.edges.get("ab")?.rail).toBe("siding");
  });

  it("skips an edge naming a node that does not exist", () => {
    // A dangling reference is a scene bug and scene.test.ts fails on it. Skipping is what
    // stops a typo taking the landing page down with it.
    const broken = buildGraph({
      ...TOY,
      edges: [
        ...TOY.edges,
        { id: "oops", from: "a", to: "nowhere", kind: "run", speed: 1 },
      ],
    });
    expect(broken.edges.get("oops")).toBeUndefined();
  });

  it("skips a node naming a road that does not exist", () => {
    const broken = buildGraph({
      ...TOY,
      nodes: [...TOY.nodes, { id: "lost", road: "nowhere", x: 0, kind: "stop" }],
    });
    expect(broken.nodes.get("lost")).toBeUndefined();
  });
});

describe("findPath", () => {
  it("finds the way across the ladder", () => {
    expect(findPath(graph, "a", "e")?.edges).toEqual(["ab", "bc", "cd", "de"]);
  });

  it("returns an empty path for a node to itself", () => {
    expect(findPath(graph, "c", "c")).toEqual({ edges: [], length: 0, marks: [] });
  });

  it("returns nothing when there is no way, or no such node", () => {
    expect(findPath(graph, "e", "a")).toBeNull();
    expect(findPath(graph, "a", "nowhere")).toBeNull();
    expect(findPath(graph, "nowhere", "a")).toBeNull();
  });

  it("weights by travel time rather than by distance", () => {
    /*
     * Weighting by distance made the slow depot road a shortcut whenever it happened to be
     * geometrically shorter, and trains crawled along it in preference to the main line
     * beside them. A long fast road has to beat a short slow one.
     */
    const forked = buildGraph({
      ...TOY,
      nodes: [...TOY.nodes, { id: "slow", road: "far", x: 50, kind: "junction" }],
      edges: [
        { id: "a-slow", from: "a", to: "slow", kind: "run", speed: 0.05 },
        { id: "slow-b", from: "slow", to: "b", kind: "run", speed: 0.05 },
        ...TOY.edges,
      ],
    });
    expect(findPath(forked, "a", "b")?.edges).toEqual(["ab"]);
  });

  it("marks the cumulative length at the end of each edge", () => {
    const path = findPath(graph, "a", "e")!;
    expect(path.marks[0]).toBeCloseTo(100);
    expect(path.marks[path.marks.length - 1]).toBeCloseTo(path.length);
    for (let index = 1; index < path.marks.length; index++) {
      expect(path.marks[index]!).toBeGreaterThan(path.marks[index - 1]!);
    }
  });
});

describe("edgeIndexAt and edgeStart", () => {
  const path = findPath(graph, "a", "e")!;

  it("finds the edge holding a distance, and where it begins", () => {
    expect(edgeIndexAt(path, 50)).toBe(0);
    expect(edgeStart(path, 0)).toBe(0);
    expect(edgeIndexAt(path, 120)).toBe(1);
    expect(edgeStart(path, 1)).toBeCloseTo(100);
  });

  it("clamps into the path at both ends", () => {
    expect(edgeIndexAt(path, -900)).toBe(0);
    expect(edgeIndexAt(path, 90_000)).toBe(path.edges.length - 1);
  });
});

describe("poseAlong", () => {
  const path = findPath(graph, "a", "e")!;

  it("returns nothing for an empty path", () => {
    expect(poseAlong(graph, { edges: [], length: 0, marks: [] }, 0)).toBeNull();
  });

  it("returns nothing when a path names an edge the graph does not have", () => {
    expect(
      poseAlong(graph, { edges: ["ghost"], length: 10, marks: [10] }, 5),
    ).toBeNull();
  });

  it("walks continuously across a junction", () => {
    /*
     * The defect this pins: the first version sampled each edge from its own hand-authored
     * control point, so two edges meeting at a node disagreed about the heading by as much
     * as 128 degrees and a locomotive spun through the join in a single frame. Every edge is
     * horizontal at its ends now, so the seam cannot exist.
     */
    const join = path.marks[0]!;
    const before = poseAlong(graph, path, join - 0.5)!;
    const after = poseAlong(graph, path, join + 0.5)!;
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(2);
    expect(Math.abs(after.angle - before.angle)).toBeLessThan(0.02);
  });

  it("puts a rake's rear wagon behind the first node rather than on top of it", () => {
    /*
     * Negative distances are the normal case, not an edge case: while a locomotive is still
     * leaving the shed its wagons are genuinely behind where the path starts. Clamping drew
     * the whole rake stacked on one point and then unfolded it, which is what made every
     * departure look like a concertina.
     */
    const behind = poseAlong(graph, path, -220)!;
    expect(behind.x).toBeCloseTo(-220);
    expect(behind.y).toBeCloseTo(100);
  });

  it("carries a train on past the end of its path", () => {
    const beyond = poseAlong(graph, path, path.length + 400)!;
    expect(beyond.x).toBeCloseTo(1200);
    expect(beyond.y).toBeCloseTo(0);
  });
});

describe("the real yard", () => {
  it("builds every edge the scene declares", () => {
    const built = buildGraph(RAIL_YARD_SCENE);
    expect(built.edges.size).toBe(RAIL_YARD_SCENE.edges.length);
    expect(built.nodes.size).toBe(RAIL_YARD_SCENE.nodes.length);
  });
});
