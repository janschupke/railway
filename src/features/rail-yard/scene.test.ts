import { describe, expect, it } from "vitest";
import {
  CONTAINER,
  GANTRY,
  LOCOMOTIVE,
  TRACK,
  WAGON,
  YARD,
  type Box,
  type VehicleSpec,
} from "./config";
import { buildGraph, findPath } from "./graph";
import { RAIL_YARD_TOKENS } from "./palette";
import { CROSSOVER_RUN, RAIL_YARD_SCENE, type SceneStructure } from "./scene";

const scene = RAIL_YARD_SCENE;
const graph = buildGraph(scene);
const roadOf = (id: string) => scene.roads.find((road) => road.id === id);
const nodeOf = (id: string) => scene.nodes.find((node) => node.id === id);

/** The longest rake this yard can make up, nose to rear coupling. */
const LONGEST_TRAIN =
  LOCOMOTIVE.length +
  YARD.WAGON_GAP +
  YARD.RAKE_SIZE[1] * (WAGON.length + YARD.WAGON_GAP);

describe("the roads", () => {
  it("names each one once", () => {
    const ids = scene.roads.map((road) => road.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("spaces the visible roads evenly, which is what makes a crossover reusable", () => {
    const depths = scene.roads
      .filter((road) => road.rail !== "hidden")
      .map((road) => road.y)
      .sort((a, b) => a - b);
    for (let index = 1; index < depths.length; index++) {
      expect(depths[index]! - depths[index - 1]!).toBe(TRACK.ROAD_PITCH);
    }
  });

  it("keeps the return road off the bottom of any canvas", () => {
    /*
     * The return is the rest of the network, and a train really does drive round it. It has
     * to be far enough in front of the camera that the projection puts it below the canvas
     * — a single edge straight between the two staging nodes was drawn diagonally across
     * the middle of the yard, with trains running backwards along it through the traffic.
     */
    const hidden = scene.roads.filter((road) => road.rail === "hidden");
    expect(hidden.length).toBeGreaterThan(0);
    for (const road of hidden) {
      expect(road.y, road.id).toBeLessThan(-scene.extent.height);
    }
  });

  it("runs every road past the frame the camera keeps", () => {
    /*
     * This is what makes leaving the scene real travel. A road that stopped at the edge of
     * `extent` would put the end of the rails on screen, and a train reaching it would have
     * to be despawned rather than driven away.
     */
    for (const road of scene.roads) {
      const [west, east] = road.span;
      expect(east - west, road.id).toBeGreaterThan(scene.extent.width / 2);
    }
  });
});

describe("the scene's topology", () => {
  it("names every node once and puts it on a declared road", () => {
    const ids = scene.nodes.map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const node of scene.nodes) {
      const road = roadOf(node.road);
      expect(road, `${node.id} names road ${node.road}`).toBeDefined();
      expect(node.x, `${node.id} inside ${node.road}`).toBeGreaterThanOrEqual(
        road!.span[0],
      );
      expect(node.x, `${node.id} inside ${node.road}`).toBeLessThanOrEqual(
        road!.span[1],
      );
    }
  });

  it.each(scene.edges)("$id joins two declared nodes", (edge) => {
    expect(nodeOf(edge.from), `${edge.id} from`).toBeDefined();
    expect(nodeOf(edge.to), `${edge.id} to`).toBeDefined();
    expect(edge.speed).toBeGreaterThan(0);
    expect(graph.edges.get(edge.id)?.length ?? 0).toBeGreaterThan(0);
  });

  it("works every road in one direction only", () => {
    /*
     * The assertion the whole yard rests on. Two trains can never want the same track from
     * opposite ends, so head-on conflict is not expressible and neither is the deadlock
     * that comes with it. Every edge running west to east is a stronger claim than "no
     * anti-parallel pair" and is what actually guarantees it.
     */
    for (const edge of scene.edges) {
      if (edge.kind === "hidden") continue;
      const from = nodeOf(edge.from)!;
      const to = nodeOf(edge.to)!;
      expect(to.x, `${edge.id} runs east`).toBeGreaterThan(from.x);
    }
  });

  it("keeps a run on one road and a crossover between two adjacent ones", () => {
    for (const edge of scene.edges) {
      if (edge.kind === "hidden") continue;
      const from = nodeOf(edge.from)!;
      const to = nodeOf(edge.to)!;
      if (edge.kind === "run") {
        expect(to.road, `${edge.id} stays on its road`).toBe(from.road);
        continue;
      }
      const drop = Math.abs(roadOf(to.road)!.y - roadOf(from.road)!.y);
      expect(drop, `${edge.id} steps one road`).toBe(TRACK.ROAD_PITCH);
    }
  });

  it("gives every crossover a real turnout ratio", () => {
    /*
     * A crossover is a curve between two straights, and how sharp it is decides whether it
     * reads as railway or as a road junction. The ladder is nearly a thousand units long
     * because of this number — shortening it is the one change here that would make the
     * track start looking wrong again.
     */
    for (const edge of scene.edges) {
      if (edge.kind !== "crossover") continue;
      const run = Math.abs(nodeOf(edge.to)!.x - nodeOf(edge.from)!.x);
      expect(run, `${edge.id} run`).toBe(CROSSOVER_RUN);
      expect(run / TRACK.ROAD_PITCH, `${edge.id} ratio`).toBeGreaterThanOrEqual(6);
    }
  });

  it("lets no two runs on one road overlap", () => {
    const byRoad = new Map<string, [number, number][]>();
    for (const edge of scene.edges) {
      if (edge.kind !== "run") continue;
      const from = nodeOf(edge.from)!;
      const to = nodeOf(edge.to)!;
      const spans = byRoad.get(from.road) ?? [];
      spans.push([from.x, to.x]);
      byRoad.set(from.road, spans);
    }
    for (const [road, spans] of byRoad) {
      spans.sort((a, b) => a[0] - b[0]);
      for (let index = 1; index < spans.length; index++) {
        expect(spans[index]![0], `${road} runs overlap`).toBeGreaterThanOrEqual(
          spans[index - 1]![1],
        );
      }
    }
  });

  it("never lets two pieces of track cross without a node between them", () => {
    /*
     * The permanent answer to "tracks go over each other". The version this replaces had
     * two edges intersecting at (275.7, 81.6) that shared no node and no id, so the
     * occupancy model had nothing to arbitrate with and two locomotives drove through one
     * another. A ladder throat has no diamonds in it, and this is the sweep that keeps it
     * that way — sample every edge to a polyline and look for a proper intersection between
     * any pair that does not already meet at a node.
     */
    const drawn = [...graph.edges.values()].filter((edge) => edge.kind !== "hidden");

    for (let a = 0; a < drawn.length; a++) {
      for (let b = a + 1; b < drawn.length; b++) {
        const first = drawn[a]!;
        const second = drawn[b]!;
        const shares =
          first.from === second.from ||
          first.from === second.to ||
          first.to === second.from ||
          first.to === second.to;
        if (shares) continue;

        for (let i = 1; i < first.samples.poses.length; i++) {
          for (let j = 1; j < second.samples.poses.length; j++) {
            const crossing = segmentsCross(
              first.samples.poses[i - 1]!,
              first.samples.poses[i]!,
              second.samples.poses[j - 1]!,
              second.samples.poses[j]!,
            );
            expect(crossing, `${first.id} crosses ${second.id}`).toBe(false);
          }
        }
      }
    }
  });
});

/** Proper intersection only: touching at an endpoint is two edges meeting, not crossing. */
function segmentsCross(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
  p4: { x: number; y: number },
): boolean {
  const side = (a: typeof p1, b: typeof p1, c: typeof p1) =>
    Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  const d1 = side(p3, p4, p1);
  const d2 = side(p3, p4, p2);
  const d3 = side(p1, p2, p3);
  const d4 = side(p1, p2, p4);
  return d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0 && d1 !== d2 && d3 !== d4;
}

describe("the duties", () => {
  it("declares at least one, with a weight", () => {
    expect(scene.duties.length).toBeGreaterThan(0);
    expect(scene.duties.reduce((sum, duty) => sum + duty.weight, 0)).toBeGreaterThan(0);
  });

  it.each(scene.duties)("$id names stops that exist", (duty) => {
    for (const key of [
      "stable",
      "loadAt",
      "unloadAt",
      "leaveVia",
      "enterVia",
    ] as const) {
      for (const id of duty[key]) {
        expect(nodeOf(id), `${duty.id}.${key} ${id}`).toBeDefined();
      }
    }
  });

  it.each(scene.duties)("$id can drive its whole cycle, and get back", (duty) => {
    /*
     * The assertion that found the unreachable depot in the first version: a stop can be on
     * the map and not on the railway. Every leg is checked, including the one that brings a
     * train home — a train that can leave and not return is a yard that empties out.
     */
    for (const stable of duty.stable) {
      for (const load of duty.loadAt) {
        for (const leave of duty.leaveVia) {
          for (const unload of duty.unloadAt) {
            expect(
              findPath(graph, stable, load),
              `${stable} to ${load}`,
            ).not.toBeNull();
            expect(findPath(graph, load, leave), `${load} to ${leave}`).not.toBeNull();
            expect(
              findPath(graph, leave, unload),
              `${leave} to ${unload}`,
            ).not.toBeNull();
            expect(
              findPath(graph, unload, stable),
              `${unload} to ${stable}`,
            ).not.toBeNull();
          }
        }
      }
    }
  });

  it("stages far enough out that no camera can reach a train standing there", () => {
    /*
     * "Away" has to mean somewhere nobody can see. The widest fit this page produces is the
     * scene's extent across the viewport, so a staging node has to clear half of that plus a
     * whole train beyond the frame's edge.
     */
    const reach = scene.focusX + scene.extent.width / 2 + LONGEST_TRAIN;
    for (const node of scene.nodes) {
      if (node.kind !== "stage") continue;
      const beyond =
        node.x > reach ||
        node.x < scene.focusX - scene.extent.width / 2 - LONGEST_TRAIN;
      expect(beyond, `${node.id} is off camera`).toBe(true);
    }
  });
});

describe("the yard's furniture", () => {
  const gantry = scene.structures.find(
    (structure): structure is Extract<SceneStructure, { kind: "gantry" }> =>
      structure.kind === "gantry",
  )!;

  it("gives the crane enough travel to reach every wagon at both stops", () => {
    /*
     * The gantry in the first version spanned *east* of the loading stop while a rake
     * extends *west*, so containers appeared on wagons that were nowhere near it. The crane
     * now aims at a real wagon, which means its travel has to cover one.
     */
    for (const node of scene.nodes) {
      if (node.kind !== "stop" || node.road === "depot") continue;
      expect(gantry.travel[0], `${node.id} tail`).toBeLessThanOrEqual(
        node.x - LONGEST_TRAIN,
      );
      expect(gantry.travel[1], `${node.id} nose`).toBeGreaterThanOrEqual(node.x);
    }
  });

  it("puts the stack under the gantry and clear of every road", () => {
    const stack = scene.structures.find(
      (structure): structure is Extract<SceneStructure, { kind: "stack" }> =>
        structure.kind === "stack",
    )!;
    const centre = stack.at[0] + stack.length / 2;
    expect(centre).toBeGreaterThanOrEqual(gantry.travel[0]);
    expect(centre).toBeLessThanOrEqual(gantry.travel[1]);
    expect(stack.at[1]).toBeGreaterThanOrEqual(gantry.near);
    expect(stack.at[1]).toBeLessThanOrEqual(gantry.far);

    // No track under the pile.
    for (const road of scene.roads) {
      if (Math.abs(road.y - stack.at[1]) > TRACK.ballastWidth / 2) continue;
      const overlaps = centre >= road.span[0] && centre <= road.span[1];
      expect(overlaps, `stack fouls ${road.id}`).toBe(false);
    }
  });

  it("stands the shed over its own road, with the stop inside it", () => {
    for (const structure of scene.structures) {
      if (structure.kind !== "shed") continue;
      const road = roadOf(structure.road);
      expect(road, `shed on ${structure.road}`).toBeDefined();

      const inside = scene.nodes.filter(
        (node) =>
          node.road === structure.road &&
          node.kind === "stop" &&
          node.x > structure.at &&
          node.x < structure.at + structure.length,
      );
      expect(inside.length, "a stop inside the shed").toBeGreaterThan(0);
    }
  });

  it("points every signal at an edge that exists", () => {
    for (const structure of scene.structures) {
      if (structure.kind !== "signal") continue;
      expect(graph.edges.get(structure.guards), structure.guards).toBeDefined();
    }
  });

  it("stands every skyline tower on the horizon", () => {
    for (const structure of scene.structures) {
      if (structure.kind !== "tower") continue;
      expect(structure.at[1]).toBe(scene.horizon);
    }
  });

  it("puts the horizon behind the whole yard", () => {
    const deepest = Math.max(...scene.roads.map((road) => road.y));
    expect(scene.horizon).toBeGreaterThan(deepest);
  });
});

describe("the sprite specs", () => {
  const SPECS: ReadonlyArray<readonly [string, VehicleSpec]> = [
    ["locomotive", LOCOMOTIVE],
    ["wagon", WAGON],
  ];
  const container: Box = { at: CONTAINER.at, size: CONTAINER.size, fill: "cargo" };

  it.each(SPECS)("%s only names colours the palette declares", (_name, spec) => {
    for (const box of spec.boxes) {
      if (box.fill === "cargo") continue;
      expect(RAIL_YARD_TOKENS[box.fill]).toBeDefined();
    }
  });

  it.each(SPECS)("%s keeps every box inside its own body", (name, spec) => {
    for (const box of spec.boxes) {
      expect(box.at[0], `${name} box starts inside`).toBeGreaterThanOrEqual(0);
      expect(box.at[0] + box.size[0], `${name} box ends inside`).toBeLessThanOrEqual(
        spec.length,
      );
      expect(box.at[1], `${name} box left`).toBeGreaterThanOrEqual(-spec.width / 2);
      expect(box.at[1] + box.size[1], `${name} box right`).toBeLessThanOrEqual(
        spec.width / 2,
      );
      expect(box.at[2], `${name} box sits on or above the rail`).toBeGreaterThanOrEqual(
        0,
      );
      for (const dimension of box.size) expect(dimension).toBeGreaterThan(0);
    }
  });

  it("puts the smoke origin on top of the stack, and the stack on top of the hood", () => {
    /*
     * Two claims, because they failed separately in the first version. The emitter has to
     * agree with the drawing about where the top of the chimney is, or puffs come out of
     * the roof; and the chimney has to stand on something, or it floats.
     */
    const { chimney } = LOCOMOTIVE;
    expect(chimney).toBeDefined();

    const over = (x: number) =>
      LOCOMOTIVE.boxes.filter((box) => x >= box.at[0] && x <= box.at[0] + box.size[0]);

    const highest = Math.max(
      ...over(chimney!.at).map((box) => box.at[2] + box.size[2]),
    );
    expect(chimney!.top, "smoke leaves the top of the stack").toBeCloseTo(highest);

    const stack = over(chimney!.at).find((box) => box.at[2] + box.size[2] === highest)!;
    const standsOn = over(chimney!.at).some(
      (box) => box !== stack && box.at[2] + box.size[2] === stack.at[2],
    );
    expect(standsOn, "the stack rests on the hood").toBe(true);
  });

  it("puts the exhaust at the front of the direction of travel", () => {
    /*
     * Local +x is forward. The first version put the stack at 15 of 62 — behind the cab in
     * the direction of travel, so the locomotive read as running backwards with its exhaust
     * trailing off the wrong end.
     */
    expect(LOCOMOTIVE.chimney!.at / LOCOMOTIVE.length).toBeGreaterThan(0.6);
  });

  it("sits the container squarely on the wagon deck", () => {
    const deck = Math.max(...WAGON.boxes.map((box) => box.at[2] + box.size[2]));
    expect(CONTAINER.deck).toBeCloseTo(deck);
    expect(container.at[2]).toBeCloseTo(deck);
    expect(container.at[0]).toBeGreaterThanOrEqual(0);
    expect(container.at[0] + container.size[0]).toBeLessThanOrEqual(WAGON.length);
    expect(Math.abs(container.at[1])).toBeLessThanOrEqual(WAGON.width / 2);
  });

  it("clears the gantry over the tallest thing that passes under it", () => {
    const loaded = CONTAINER.deck + CONTAINER.size[2];
    expect(GANTRY.height).toBeGreaterThan(Math.max(loaded, LOCOMOTIVE.chimney!.top));
  });
});
