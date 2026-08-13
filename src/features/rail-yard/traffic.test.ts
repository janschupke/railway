import { describe, expect, it } from "vitest";
import { YARD } from "./config";
import { buildGraph, findPath, type RailGraph } from "./graph";
import { aspectOf, limitFor, occupancyOf } from "./traffic";
import type { RailScene } from "./scene";

/**
 * Two roads, a run each, and a crossover between them — plus a second way onto the far
 * road, so two workings converge at one node. That convergence is the whole reason this
 * file exists, and a scene small enough to reason about by hand is the only way to assert
 * it precisely.
 */
const TOY: RailScene = {
  extent: { width: 600, height: 60 },
  focusX: 300,
  horizon: 300,
  roads: [
    { id: "near", y: 0, span: [0, 2000], rail: "main" },
    { id: "far", y: 60, span: [0, 2000], rail: "siding" },
  ],
  nodes: [
    { id: "a", road: "far", x: 0, kind: "stop" },
    { id: "b", road: "far", x: 400, kind: "junction" },
    { id: "c", road: "near", x: 800, kind: "junction" },
    { id: "d", road: "near", x: 1600, kind: "stop" },
    { id: "p", road: "near", x: 0, kind: "stop" },
    { id: "q", road: "near", x: 400, kind: "junction" },
  ],
  edges: [
    { id: "ab", from: "a", to: "b", kind: "run", speed: 1 },
    { id: "bc", from: "b", to: "c", kind: "crossover", speed: 1 },
    { id: "cd", from: "c", to: "d", kind: "run", speed: 1 },
    { id: "pq", from: "p", to: "q", kind: "run", speed: 1 },
    { id: "qc", from: "q", to: "c", kind: "run", speed: 1 },
  ],
  structures: [],
  duties: [
    {
      id: "toy",
      weight: 1,
      stable: ["a"],
      loadAt: ["b"],
      unloadAt: ["c"],
      leaveVia: ["d"],
      enterVia: ["a"],
    },
  ],
};

const graph: RailGraph = buildGraph(TOY);
const overTheTop = findPath(graph, "a", "d")!;
const alongTheFront = findPath(graph, "p", "d")!;

const body = (id: string, path = overTheTop, distance = 0, length = 60) => ({
  id,
  path,
  distance,
  length,
});

describe("occupancyOf", () => {
  it("puts a body on every edge it lies across", () => {
    // A rake straddling a junction is on both edges at once, which is the case the
    // whole-edge model could not express and the reason a follower had to wait a block.
    const spanning = body("one", overTheTop, overTheTop.marks[0]! + 20, 200);
    const { onEdge } = occupancyOf(graph, [spanning]);
    expect(onEdge.get("ab")?.[0]?.train).toBe("one");
    expect(onEdge.get("bc")?.[0]?.train).toBe("one");
  });

  it("ignores a body that has not reached its path yet", () => {
    expect(occupancyOf(graph, [body("one", overTheTop, 0, 60)]).onEdge.size).toBe(0);
  });

  it("ignores a path with no edges at all", () => {
    const empty = { edges: [], length: 0, marks: [] };
    expect(occupancyOf(graph, [body("one", empty)]).onEdge.size).toBe(0);
  });

  it("claims the junctions ahead as well as the ones it is standing on", () => {
    /*
     * The interlock. Watching only where trains *are* is not enough: two of them a unit
     * short of the same node both see it empty on the same step and both take it.
     */
    const approaching = body("one", overTheTop, overTheTop.marks[0]! - 40, 60);
    const claims = occupancyOf(graph, [approaching]).atNode.get("b");
    expect(claims?.map((claim) => claim.train)).toEqual(["one"]);
    expect(claims?.[0]?.away).toBeCloseTo(40);
  });

  it("claims the node a leg terminates at", () => {
    // No edge on the path names it as a `from`, so it needs its own claim or a train
    // standing at a stop is invisible to anything routing through it.
    const arriving = body("one", overTheTop, overTheTop.length - 30, 60);
    expect(occupancyOf(graph, [arriving]).atNode.get("d")?.[0]?.train).toBe("one");
  });

  it("lets a node go once the tail has cleared it", () => {
    const gone = body("one", overTheTop, overTheTop.marks[0]! + 400, 60);
    expect(occupancyOf(graph, [gone]).atNode.get("b")).toBeUndefined();
  });
});

describe("limitFor", () => {
  const clear = () => occupancyOf(graph, []);

  it("gives a train its own stop when nothing is in the way", () => {
    const authority = limitFor(graph, clear(), body("one", overTheTop, 100), 900);
    expect(authority).toEqual({ limit: 900, reason: "stop" });
  });

  it("reports clear when a leg has no stop at all", () => {
    // Hauling off the side of the world: there is nothing to arrive at.
    const authority = limitFor(graph, clear(), body("one", overTheTop, 100), Infinity);
    expect(authority.reason).toBe("clear");
  });

  it("returns the stop for a train with no path", () => {
    const empty = { edges: [], length: 0, marks: [] };
    expect(limitFor(graph, clear(), body("one", empty), 42).limit).toBe(42);
  });

  it("holds a follower a headway behind the train in front", () => {
    /*
     * The resolution half of the repair. A claim used to cover a whole edge, so two trains
     * could not be nearer than one edge apart — a follower stopped a road-length back and
     * the two never looked aware of each other.
     */
    const leader = body("leader", overTheTop, 900, 120);
    const follower = body("follower", overTheTop, 400, 60);
    const occupancy = occupancyOf(graph, [leader, follower]);

    const authority = limitFor(graph, occupancy, follower, Infinity);
    expect(authority.reason).toBe("headway");
    expect(authority.limit).toBeCloseTo(900 - 120 - YARD.HEADWAY);
  });

  it("ignores a train that is already behind it", () => {
    const leader = body("leader", overTheTop, 900, 120);
    const follower = body("follower", overTheTop, 400, 60);
    const occupancy = occupancyOf(graph, [leader, follower]);
    expect(limitFor(graph, occupancy, leader, Infinity).reason).toBe("clear");
  });

  it("makes the further train give way at a converging junction", () => {
    /*
     * Both trains read the same snapshot and apply the same rule, so they always agree on
     * who goes. Nearest first, and the id breaks a tie — which is what makes this an
     * interlock rather than two independent guesses.
     */
    const near = body("near-train", alongTheFront, alongTheFront.marks[1]! - 30, 60);
    const far = body("far-train", overTheTop, overTheTop.marks[1]! - 120, 60);
    const occupancy = occupancyOf(graph, [near, far]);

    expect(limitFor(graph, occupancy, far, Infinity).reason).toBe("junction");
    expect(limitFor(graph, occupancy, near, Infinity).reason).not.toBe("junction");
  });

  it("breaks an exact tie by name, so neither train waits for the other", () => {
    const at = overTheTop.marks[1]! - 90;
    const first = body("a-train", alongTheFront, alongTheFront.marks[1]! - 90, 60);
    const second = body("b-train", overTheTop, at, 60);
    const occupancy = occupancyOf(graph, [first, second]);

    expect(limitFor(graph, occupancy, second, Infinity).reason).toBe("junction");
    expect(limitFor(graph, occupancy, first, Infinity).reason).not.toBe("junction");
  });

  it("never contests the junction under its own nose", () => {
    // Contesting the node a train is already standing on is how the previous model
    // managed to block every train in the yard against itself on the first frame.
    const alone = body("one", overTheTop, overTheTop.marks[0]!, 200);
    const occupancy = occupancyOf(graph, [alone]);
    expect(limitFor(graph, occupancy, alone, Infinity).reason).toBe("clear");
  });
});

describe("aspectOf", () => {
  it("shows clear when nothing is on the road it guards", () => {
    expect(aspectOf(graph, occupancyOf(graph, []), "bc")).toBe("go");
  });

  it("shows danger when the road it guards is occupied", () => {
    const on = body("one", overTheTop, overTheTop.marks[0]! + 40, 60);
    expect(aspectOf(graph, occupancyOf(graph, [on]), "bc")).toBe("stop");
  });

  it("shows caution when the road beyond it is occupied", () => {
    // Far enough on that the rake's own tail has cleared the guarded edge — a train still
    // lying across it is a danger, not a caution.
    const beyond = body("one", overTheTop, overTheTop.marks[1]! + 120, 60);
    expect(aspectOf(graph, occupancyOf(graph, [beyond]), "bc")).toBe("caution");
  });

  it("shows caution for a train standing at the node it protects", () => {
    // Approaching the same node by the other road: nothing is on `bc`, but the junction
    // beyond it is taken, and a driver needs to know that before the last moment.
    const waiting = body("one", alongTheFront, alongTheFront.marks[1]!, 60);
    expect(aspectOf(graph, occupancyOf(graph, [waiting]), "bc")).toBe("caution");
  });

  it("shows clear for an edge the graph does not have", () => {
    expect(aspectOf(graph, occupancyOf(graph, []), "ghost")).toBe("go");
  });
});
