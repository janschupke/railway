/**
 * The fixtures every rail-yard drawing test needs before it can draw anything.
 *
 * These were the preamble of `render.test.ts` back when one test file covered three source
 * modules. Splitting it so `draw-box.ts` and `draw-scene.ts` have colocated tests of their
 * own left the palette, the view and the scene lookups wanted in three places, so they
 * live here rather than being pasted into each.
 *
 * Note what this file may not do, and why — the same rule `log-capture.ts` carries.
 * `knip.jsonc` ignores `src/test/**`, so an import from here does **not** register as
 * usage: a production symbol whose only reader was this file would be reported as dead
 * code. Everything imported below is used by the app as well, and a fixture that needs
 * something the app does not use belongs in the test that wants it.
 */

import { YARD } from "@/features/rail-yard/config";
import type { Pose } from "@/features/rail-yard/geometry";
import { buildGraph } from "@/features/rail-yard/graph";
import {
  FREIGHT_TOKENS,
  RAIL_YARD_TOKENS,
  type YardPalette,
} from "@/features/rail-yard/palette";
import { createRng } from "@/features/rail-yard/rng";
import { RAIL_YARD_SCENE } from "@/features/rail-yard/scene";
import type { SceneStructure } from "@/features/rail-yard/scene-types";
import { createWorld } from "@/features/rail-yard/create-world";
import { step } from "@/features/rail-yard/simulation";
import type { WorldState } from "@/features/rail-yard/world-state";
import { fitView } from "@/features/rail-yard/view";
import type { FakeContext } from "./fake-canvas-2d";

/**
 * A palette of distinguishable placeholders.
 *
 * Not real colours: what the renderer must never do is paint in something the palette did
 * not hand it, and a set of tagged strings makes that a set-membership assertion rather
 * than a pixel comparison.
 */
export const PALETTE: YardPalette = {
  ...(Object.fromEntries(
    Object.keys(RAIL_YARD_TOKENS).map((key) => [key, `#${key}`]),
  ) as Record<keyof typeof RAIL_YARD_TOKENS, string>),
  freight: FREIGHT_TOKENS.map((_, index) => `#freight-${index}`),
};

/** Every colour the palette can legitimately produce, for "painted nothing else" checks. */
export const KNOWN = new Set([...Object.values(PALETTE).flat()]);

export const VIEWPORT = { width: 960, height: 700, dpr: 1 };
export const view = fitView(RAIL_YARD_SCENE, VIEWPORT)!;
export const graph = buildGraph(RAIL_YARD_SCENE);

/** The yard, wound forward a given number of fixed steps from its seeded start. */
export function yard(steps = 0): WorldState {
  const rng = createRng(YARD.SEED);
  const world = createWorld(rng);
  for (let index = 0; index < steps; index++) step(world, 20, rng);
  return world;
}

/** Every number a recorded context was handed, for range and ordering assertions. */
export const numbers = (recorder: FakeContext) =>
  recorder.ops.flatMap((entry) => entry.args.filter((arg) => typeof arg === "number"));

export const SHED_STRUCTURE = RAIL_YARD_SCENE.structures.find(
  (structure): structure is Extract<SceneStructure, { kind: "shed" }> =>
    structure.kind === "shed",
)!;

export const GANTRY_STRUCTURE = RAIL_YARD_SCENE.structures.find(
  (structure): structure is Extract<SceneStructure, { kind: "gantry" }> =>
    structure.kind === "gantry",
)!;

/** The plane a shed's front wall stands in — half its depth in front of its road. */
export const shedFrontY = (): number =>
  RAIL_YARD_SCENE.roads.find((road) => road.id === SHED_STRUCTURE.road)!.y -
  SHED_STRUCTURE.depth / 2;

/** A structure's pose: standing still, facing east. Structures do not have headings. */
export const at = (x: number, y: number): Pose => ({ x, y, angle: 0 });
