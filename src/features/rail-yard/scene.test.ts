import { describe, expect, it } from "vitest";
import { CONTAINER, LOCOMOTIVE, SHED, WAGON, type VehicleSpec } from "./config";
import { buildGraph, findPath } from "./graph";
import { RAIL_YARD_SCENE } from "./scene";
import { RAIL_YARD_TOKENS } from "./palette";

/**
 * The scene validates itself.
 *
 * Every claim the literal in scene.ts makes about its own shape is asserted here, because
 * a yard that cannot be driven does not throw — it renders a blank canvas with three
 * locomotives standing in sheds forever, and nothing else in the app would notice. The
 * missing in-edge to depot-south was found by the duty-cycle assertion below, not by
 * looking at the picture.
 */
const scene = RAIL_YARD_SCENE;
const graph = buildGraph(scene);
const nodes = new Map(scene.nodes.map((node) => [node.id, node]));

describe("the scene's topology", () => {
  it("gives every node and edge a unique id", () => {
    expect(new Set(scene.nodes.map((node) => node.id)).size).toBe(scene.nodes.length);
    expect(new Set(scene.edges.map((edge) => edge.id)).size).toBe(scene.edges.length);
  });

  it.each(scene.edges.map((edge) => [edge.id, edge] as const))(
    "%s connects declared nodes",
    (_id, edge) => {
      expect(nodes.has(edge.from), `${edge.id}.from`).toBe(true);
      expect(nodes.has(edge.to), `${edge.id}.to`).toBe(true);
      expect(edge.from).not.toBe(edge.to);
    },
  );

  it("declares no anti-parallel pair", () => {
    /*
     * This is the assertion that makes deadlock impossible, and it belongs here rather
     * than in the simulation: with every edge directed and no two edges joining the same
     * pair in opposite senses, two trains can never want the same track from opposite
     * ends, so there is no head-on conflict for an occupancy rule to resolve.
     */
    const pairs = new Set(scene.edges.map((edge) => `${edge.from}>${edge.to}`));
    for (const edge of scene.edges) {
      expect(
        pairs.has(`${edge.to}>${edge.from}`),
        `${edge.id} is reversed elsewhere`,
      ).toBe(false);
    }
  });

  it("gives every edge a positive speed", () => {
    for (const edge of scene.edges) {
      expect(edge.speed, edge.id).toBeGreaterThan(0);
    }
  });

  it("measures every edge as having length", () => {
    for (const edge of scene.edges) {
      expect(graph.edges.get(edge.id)?.length ?? 0, edge.id).toBeGreaterThan(0);
    }
  });

  it("keeps the yard inside the frame and the exits outside it", () => {
    for (const node of scene.nodes) {
      const inside = node.at[0] >= 0 && node.at[0] <= scene.extent.width;
      expect(inside, `${node.id} at x=${node.at[0]}`).toBe(node.kind !== "exit");
    }
    expect(scene.focusX).toBeGreaterThan(0);
    expect(scene.focusX).toBeLessThan(scene.extent.width);
  });

  it("puts the horizon above the yard", () => {
    const highest = Math.max(...scene.nodes.map((node) => node.at[1]));
    expect(scene.horizon).toBeGreaterThan(highest);
    expect(scene.horizon).toBeLessThanOrEqual(scene.extent.height);
  });

  it("stands every skyline tower on the horizon", () => {
    for (const structure of scene.structures) {
      if (structure.kind !== "tower") continue;
      expect(structure.at[1]).toBe(scene.horizon);
    }
  });

  it("points every signal at an edge that exists", () => {
    for (const structure of scene.structures) {
      if (structure.kind !== "signal") continue;
      expect(graph.edges.has(structure.guards), structure.guards).toBe(true);
    }
  });
});

describe("the duties", () => {
  it("has at least one, with weight between them", () => {
    expect(scene.duties.length).toBeGreaterThan(0);
    const total = scene.duties.reduce((sum, duty) => sum + duty.weight, 0);
    expect(total).toBeGreaterThan(0);
  });

  it.each(scene.duties.map((duty) => [duty.id, duty] as const))(
    "%s names waypoints of the right kind",
    (_id, duty) => {
      const kinds = {
        home: "depot",
        loadAt: "bay",
        exitVia: "exit",
        enterVia: "exit",
      } as const;
      for (const [field, kind] of Object.entries(kinds)) {
        for (const id of duty[field as keyof typeof kinds]) {
          expect(nodes.get(id)?.kind, `${duty.id}.${field} → ${id}`).toBe(kind);
        }
      }
      expect(duty.wagons[0]).toBeGreaterThan(0);
      expect(duty.wagons[1]).toBeGreaterThanOrEqual(duty.wagons[0]);
    },
  );

  it.each(scene.duties.map((duty) => [duty.id, duty] as const))(
    "%s can complete its whole cycle",
    (_id, duty) => {
      /*
       * All four legs, every combination of waypoints. This is what caught depot-south
       * having no in-edge: it was reachable on the map and not by a train, so a duty
       * that homed there went out once and never came back.
       */
      for (const home of duty.home) {
        for (const bay of duty.loadAt) {
          for (const exit of duty.exitVia) {
            for (const entry of duty.enterVia) {
              const legs = [
                [home, bay],
                [bay, exit],
                [entry, bay],
                [bay, home],
              ] as const;
              for (const [from, to] of legs) {
                expect(findPath(graph, from, to), `${from} → ${to}`).not.toBeNull();
              }
            }
          }
        }
      }
    },
  );
});

describe("the sprite specs", () => {
  const specs: ReadonlyArray<[string, VehicleSpec]> = [
    ["locomotive", LOCOMOTIVE],
    ["wagon", WAGON],
    ["shed", SHED],
  ];

  it.each(specs)("%s only names colours the palette declares", (_name, spec) => {
    // A spec referencing a token nobody declares would paint the previous colour, which
    // is a failure nothing else in the app can see.
    for (const part of spec.parts) {
      if (part.fill === "cargo") continue;
      expect(RAIL_YARD_TOKENS[part.fill], part.fill).toBeDefined();
    }
  });

  it.each(specs)("%s keeps its parts inside its own length", (_name, spec) => {
    for (const part of spec.parts) {
      expect(part.rect[0]).toBeGreaterThanOrEqual(0);
      expect(part.rect[0] + part.rect[2]).toBeLessThanOrEqual(spec.length);
      expect(part.rect[2]).toBeGreaterThan(0);
      expect(part.rect[3]).toBeGreaterThan(0);
    }
  });

  it("stands the locomotive's chimney on one of its own parts", () => {
    const chimney = LOCOMOTIVE.chimney;
    expect(chimney).toBeDefined();
    /*
     * The base has to coincide with the top of a part. The smoke origin is derived from
     * it — `base + height` is where a puff is emitted — so a base that matches nothing
     * puts the exhaust in mid-air above the locomotive.
     */
    const tops = LOCOMOTIVE.parts.map((part) => part.rect[1] + part.rect[3]);
    expect(tops).toContain(chimney!.base);
    expect(chimney!.at).toBeGreaterThan(0);
    expect(chimney!.at).toBeLessThan(LOCOMOTIVE.length);
  });

  it("keeps the container on the wagon deck", () => {
    expect(CONTAINER.rect[0]).toBeGreaterThanOrEqual(0);
    expect(CONTAINER.rect[0] + CONTAINER.rect[2]).toBeLessThanOrEqual(WAGON.length);
    expect(CONTAINER.ribs[0]).toBeGreaterThan(0);
    expect(CONTAINER.ribs[1]).toBeGreaterThanOrEqual(CONTAINER.ribs[0]);
    expect(CONTAINER.doorWidth).toBeLessThan(CONTAINER.rect[2]);
  });

  it("puts every wheel under the vehicle it belongs to", () => {
    // Rim to rim, not centre to centre. The wagon's rear wheel overhung its own frame by
    // a unit, which reads at any scale as a bogie hanging off the back.
    for (const [name, spec] of specs) {
      for (const bogie of spec.bogies) {
        const last = bogie.at + (bogie.count - 1) * bogie.pitch;
        expect(bogie.at - bogie.radius, name).toBeGreaterThanOrEqual(0);
        expect(last + bogie.radius, name).toBeLessThanOrEqual(spec.length);
      }
    }
  });
});
