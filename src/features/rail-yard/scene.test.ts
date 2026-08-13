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

  it("works every road in the one direction it declares", () => {
    /*
     * The assertion the whole yard rests on. Two trains can never want the same rails from
     * opposite ends, so head-on conflict is not expressible and neither is the deadlock
     * that comes with it.
     *
     * Every along-road edge, hidden ones included. A hidden road is still a piece of
     * railway two trains can be on at once, and a conflict nobody can see is still a
     * conflict — which is why each circuit has a loop of its own rather than sharing one.
     * Edges that *leave* one road for another are the exception, and only those.
     */
    for (const edge of scene.edges) {
      const from = nodeOf(edge.from)!;
      const to = nodeOf(edge.to)!;
      if (from.road !== to.road) continue;
      const sense = roadOf(from.road)!.sense;
      const runs = to.x > from.x ? "east" : "west";
      expect(runs, `${edge.id} runs ${sense}`).toBe(sense);
    }
  });

  it("gives the westbound line no turnouts at all", () => {
    /*
     * What makes running one road the other way free. A crossover onto it would be track
     * shared between two senses, and the deadlock argument would have to become an argument
     * about timing instead of an argument about shape.
     */
    const westbound = scene.roads.filter((road) => road.sense === "west");
    for (const road of westbound) {
      if (road.rail === "hidden") continue;
      const turnouts = scene.edges.filter(
        (edge) =>
          edge.kind === "crossover" &&
          (nodeOf(edge.from)!.road === road.id || nodeOf(edge.to)!.road === road.id),
      );
      expect(
        turnouts.map((edge) => edge.id),
        `${road.id} turnouts`,
      ).toEqual([]);
    }
  });

  it("never crosses one sense with another", () => {
    // A crossover steps between adjacent roads, and both of them have to be worked the same
    // way or the step itself is a head-on conflict.
    for (const edge of scene.edges) {
      if (edge.kind !== "crossover") continue;
      const from = roadOf(nodeOf(edge.from)!.road)!;
      const to = roadOf(nodeOf(edge.to)!.road)!;
      expect(to.sense, `${edge.id} senses`).toBe(from.sense);
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
      // West to east whichever way the road is worked: this is about where the rails are,
      // not about which way anything travels along them.
      spans.push([Math.min(from.x, to.x), Math.max(from.x, to.x)]);
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
     *
     * Hidden track included, and it did not used to be. Leaving it out is exactly how two
     * hidden approaches came to converge on the same node along nearly the same line: the
     * traffic model has nothing to arbitrate with until rails meet where a node says they
     * do, so a train ran straight through another five hundred units short of it. Nobody
     * could see it happen, which makes it worse rather than better.
     */
    const all = [...graph.edges.values()];

    for (let a = 0; a < all.length; a++) {
      for (let b = a + 1; b < all.length; b++) {
        const first = all[a]!;
        const second = all[b]!;
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

  it.each(scene.expresses)("$id can run its lap and get back to hold", (express) => {
    expect(nodeOf(express.holdAt), `${express.id} hold`).toBeDefined();
    expect(nodeOf(express.runTo), `${express.id} destination`).toBeDefined();
    expect(findPath(graph, express.holdAt, express.runTo)).not.toBeNull();
    expect(findPath(graph, express.runTo, express.holdAt)).not.toBeNull();
  });

  it("holds every express on track no other working uses", () => {
    /*
     * The reason an express is a train rather than a duty, stated as a property of the
     * scene. It waits somewhere off camera that nothing else needs, so an express standing
     * between runs costs the yard nothing — and a yard train that has hauled away waits on
     * its own loop for the same reason, rather than at the end of the running line where it
     * would be in the express's way for its whole dwell.
     */
    const held = scene.expresses.map((express) => nodeOf(express.holdAt)!);
    const parked = scene.duties.flatMap((duty) => [
      ...duty.leaveVia.map((id) => nodeOf(id)!),
      ...duty.stable.map((id) => nodeOf(id)!),
    ]);

    for (const node of held) {
      expect(roadOf(node.road)!.rail, `${node.id} is hidden`).toBe("hidden");
      for (const other of [...held, ...parked]) {
        if (other === node) continue;
        expect(
          other.road === node.road && other.x === node.x,
          `${node.id} shared`,
        ).toBe(false);
      }
    }
  });

  it("runs each express the length of a road nobody stops on", () => {
    // "Passing through, skipping the loading logic" — an express's route has to reach both
    // sides of the frame, or it is a train that appears in the middle of the scene.
    for (const express of scene.expresses) {
      const path = findPath(graph, express.holdAt, express.runTo)!;
      const visited = path.edges.flatMap((id) => {
        const edge = graph.edges.get(id)!;
        return [nodeOf(edge.from)!, nodeOf(edge.to)!];
      });
      const xs = visited.map((node) => node.x);
      expect(Math.min(...xs), express.id).toBeLessThan(
        scene.focusX - scene.extent.width / 2,
      );
      expect(Math.max(...xs), express.id).toBeGreaterThan(
        scene.focusX + scene.extent.width / 2,
      );
      // And it stops nowhere in between.
      for (const node of visited) {
        expect(node.kind, `${express.id} passes ${node.id}`).not.toBe("stop");
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

  it("puts the belt's head under the gantry and clear of every road", () => {
    const belt = scene.structures.find(
      (structure): structure is Extract<SceneStructure, { kind: "conveyor" }> =>
        structure.kind === "conveyor",
    )!;
    const [headX, y] = belt.at;
    expect(headX).toBeGreaterThanOrEqual(gantry.travel[0]);
    expect(headX).toBeLessThanOrEqual(gantry.travel[1]);
    expect(y).toBeGreaterThanOrEqual(gantry.near);
    expect(y).toBeLessThanOrEqual(gantry.far);

    // No track under the belt, anywhere along it.
    for (const road of scene.roads) {
      if (Math.abs(road.y - y) > TRACK.ballastWidth / 2) continue;
      const overlaps = headX <= road.span[1] && headX + belt.length >= road.span[0];
      expect(overlaps, `the belt fouls ${road.id}`).toBe(false);
    }
  });

  it("runs the belt's tail off the side of the frame", () => {
    /*
     * The whole point of a belt over the pile it replaces: freight has to arrive from
     * somewhere and leave for somewhere. Boxes enter and are taken away at the tail, so the
     * tail has to be as far outside the camera as a staging node is, or the yard is back to
     * conjuring containers in plain view.
     */
    const belt = scene.structures.find(
      (structure): structure is Extract<SceneStructure, { kind: "conveyor" }> =>
        structure.kind === "conveyor",
    )!;
    expect(belt.at[0] + belt.length).toBeGreaterThan(
      scene.focusX + scene.extent.width / 2,
    );
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
