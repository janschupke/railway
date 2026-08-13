import { describe, expect, it } from "vitest";
import { buildGraph, edgeIndexAt, findPath, poseAlong } from "./graph";
import { RAIL_YARD_SCENE, type RailScene } from "./scene";

const graph = buildGraph(RAIL_YARD_SCENE);

/** A three-node line with one branch, small enough to reason about by hand. */
const toy: RailScene = {
  extent: { width: 100, height: 100 },
  focusX: 50,
  horizon: 80,
  nodes: [
    { id: "a", at: [0, 0], kind: "depot" },
    { id: "b", at: [40, 0], kind: "junction" },
    { id: "c", at: [100, 0], kind: "bay" },
    { id: "lonely", at: [50, 50], kind: "siding" },
  ],
  edges: [
    {
      id: "ab",
      from: "a",
      to: "b",
      shape: { type: "straight" },
      rail: "main",
      speed: 1,
    },
    {
      id: "bc",
      from: "b",
      to: "c",
      shape: { type: "straight" },
      rail: "main",
      speed: 1,
    },
    // Same endpoints, half the speed and a detour: it must lose on travel time.
    {
      id: "slow",
      from: "a",
      to: "c",
      shape: { type: "curve", via: [50, 30] },
      rail: "siding",
      speed: 0.2,
    },
  ],
  structures: [],
  duties: [
    {
      id: "toy",
      weight: 1,
      home: ["a"],
      loadAt: ["c"],
      exitVia: ["c"],
      enterVia: ["a"],
      wagons: [1, 1],
    },
  ],
};

describe("buildGraph", () => {
  it("indexes every node and edge", () => {
    expect(graph.nodes.size).toBe(RAIL_YARD_SCENE.nodes.length);
    expect(graph.edges.size).toBe(RAIL_YARD_SCENE.edges.length);
  });

  it("indexes adjacency in the declared direction only", () => {
    expect(graph.out.get("bay-west")?.map((edge) => edge.id)).toEqual(["bay-road"]);
    // bay-road is bay-west → bay-east, so bay-east leads on rather than back.
    expect(graph.out.get("bay-east")?.map((edge) => edge.id)).not.toContain("bay-road");
  });

  it("skips an edge that names a node the scene does not declare", () => {
    // A typo should cost that edge, not the landing page.
    const broken = buildGraph({
      ...toy,
      edges: [
        ...toy.edges,
        {
          id: "dangling",
          from: "a",
          to: "nowhere",
          shape: { type: "straight" },
          rail: "main",
          speed: 1,
        },
      ],
    });
    expect(broken.edges.has("dangling")).toBe(false);
    expect(broken.edges.size).toBe(toy.edges.length);
  });
});

describe("findPath", () => {
  const toyGraph = buildGraph(toy);

  it("returns contiguous edges", () => {
    const path = findPath(graph, "depot-north", "exit-east");
    expect(path).not.toBeNull();
    for (let index = 1; index < path!.edges.length; index++) {
      const previous = graph.edges.get(path!.edges[index - 1]!)!;
      const current = graph.edges.get(path!.edges[index]!)!;
      expect(previous.to).toBe(current.from);
    }
  });

  it("reports a length equal to the sum of its edges", () => {
    const path = findPath(graph, "depot-north", "exit-east")!;
    const summed = path.edges.reduce(
      (total, id) => total + (graph.edges.get(id)?.length ?? 0),
      0,
    );
    expect(path.length).toBeCloseTo(summed);
  });

  it("produces a strictly increasing mark table ending at the length", () => {
    const path = findPath(graph, "depot-north", "exit-east")!;
    expect(path.marks).toHaveLength(path.edges.length);
    for (let index = 1; index < path.marks.length; index++) {
      expect(path.marks[index]!).toBeGreaterThan(path.marks[index - 1]!);
    }
    expect(path.marks[path.marks.length - 1]).toBeCloseTo(path.length);
  });

  it("weighs by travel time rather than distance", () => {
    /*
     * `slow` joins a to c directly and is geometrically the shorter option in edge count,
     * but it runs at a fifth of line speed. Weighting by distance sent every train down
     * the siding at a crawl in preference to the main line beside it.
     */
    expect(findPath(toyGraph, "a", "c")!.edges).toEqual(["ab", "bc"]);
  });

  it("returns an empty path for a node to itself", () => {
    const path = findPath(graph, "bay-west", "bay-west")!;
    expect(path.edges).toEqual([]);
    expect(path.length).toBe(0);
  });

  it("returns null when there is no way through", () => {
    expect(findPath(toyGraph, "a", "lonely")).toBeNull();
    // Directed: c has no outgoing edge at all.
    expect(findPath(toyGraph, "c", "a")).toBeNull();
  });

  it("returns null for a node that does not exist", () => {
    expect(findPath(graph, "bay-west", "atlantis")).toBeNull();
    expect(findPath(graph, "atlantis", "bay-west")).toBeNull();
  });
});

describe("edgeIndexAt", () => {
  const path = findPath(graph, "depot-north", "exit-east")!;

  it("clamps into the path at both ends", () => {
    expect(edgeIndexAt(path, -1_000)).toBe(0);
    expect(edgeIndexAt(path, path.length * 10)).toBe(path.edges.length - 1);
  });

  it("puts a distance just past a mark onto the next edge", () => {
    const first = path.marks[0]!;
    expect(edgeIndexAt(path, first - 0.1)).toBe(0);
    expect(edgeIndexAt(path, first + 0.1)).toBe(1);
  });
});

describe("poseAlong", () => {
  const path = findPath(graph, "depot-north", "exit-east")!;

  it("starts on the origin node and ends on the destination", () => {
    const from = graph.nodes.get("depot-north")!.at;
    const to = graph.nodes.get("exit-east")!.at;
    const start = poseAlong(graph, path, 0)!;
    const end = poseAlong(graph, path, path.length)!;
    expect([start.x, start.y]).toEqual([from[0], from[1]]);
    expect(end.x).toBeCloseTo(to[0]);
    expect(end.y).toBeCloseTo(to[1]);
  });

  it("clamps rather than extrapolating past either end", () => {
    expect(poseAlong(graph, path, -500)).toEqual(poseAlong(graph, path, 0));
    expect(poseAlong(graph, path, path.length + 500)).toEqual(
      poseAlong(graph, path, path.length),
    );
  });

  it("moves monotonically along the path", () => {
    let previous = poseAlong(graph, path, 0)!;
    for (let at = 20; at <= path.length; at += 20) {
      const pose = poseAlong(graph, path, at)!;
      expect(Number.isFinite(pose.x) && Number.isFinite(pose.y)).toBe(true);
      expect(pose.x).toBeGreaterThanOrEqual(previous.x - 1);
      previous = pose;
    }
  });

  it("returns null for an empty path", () => {
    expect(poseAlong(graph, { edges: [], length: 0, marks: [] }, 0)).toBeNull();
  });
});
