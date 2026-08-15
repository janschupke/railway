/**
 * The fixed things in the yard, as boxes: sheds, the gantry, the conveyor.
 *
 * Box specs rather than drawing — nothing here touches a canvas. That is what makes the
 * shed assertable as geometry, and it is why the three faces of one building are together
 * again. They were not: the front wall and the roof were in `render.ts` and the back wall
 * in `draw-scene.ts`, one file apart, each with a comment explaining the other's half.
 *
 * The split between them is real and worth keeping — the back wall is baked into the static
 * layer because nothing can get in front of it, while the front wall and roof are drawables
 * so a train can stand inside the shed — but that is a decision about *when* each face is
 * painted, not about where the shape of a shed is written down.
 */

import { CONVEYOR } from "./config";
import { GANTRY, SHED, type Box } from "./sprites";
import { spreaderZ } from "./crane";
import { standingDrawable, type Drawable } from "./drawable";
import type { YardPalette } from "./palette";
import { containerAt } from "./place-train";
import type { SceneStructure } from "./scene-types";
import type { WorldState } from "./world-state";

type Shed = Extract<SceneStructure, { kind: "shed" }>;

/**
 * A shed's front wall: a lintel over a row of piers.
 *
 * Piers rather than a hole punched through a solid wall: cutting one would need
 * `globalCompositeOperation`, which is a second rendering mode to reason about and a new op
 * for the recording fake to learn. `bays + 1` uprights between `bays` doorways is the same
 * picture, in the same box walker, at five fills.
 *
 * Measured from the **front plane**, which is where the drawable's pose already puts it. They
 * were measured from the shed's centre as well, so the offset went on twice and the wall
 * stood a whole depth in front of the building.
 */
export function shedFrontBoxes(structure: Shed): Box[] {
  const boxes: Box[] = [
    {
      at: [0, 0, SHED.doorHeight],
      size: [structure.length, SHED.wallThickness, structure.height - SHED.doorHeight],
      fill: "structure",
    },
  ];

  const piers = structure.bays + 1;
  const opening = (structure.length - piers * SHED.pierWidth) / structure.bays;
  for (let index = 0; index < piers; index++) {
    boxes.push({
      at: [index * (SHED.pierWidth + opening), 0, 0],
      size: [SHED.pierWidth, SHED.wallThickness, SHED.doorHeight],
      fill: "structure",
    });
  }
  return boxes;
}

/**
 * The back wall of a shed, which is the only part of one nothing can get in front of.
 *
 * Baked into the static layer for exactly that reason, while the two faces above and below
 * it are drawables.
 */
export function shedBackBoxes(structure: Shed): readonly Box[] {
  const half = structure.depth / 2;
  return [
    {
      at: [0, half - SHED.wallThickness, 0],
      size: [structure.length, SHED.wallThickness, structure.height],
      // The inside of the building, which is what the doorways frame. See the token.
      fill: "structureShade",
    },
  ];
}

/**
 * A shed's roof, as its own assembly.
 *
 * Its own, and out of the static layer, which is the rest of "the roof isn't touching the
 * walls". Baked, it was painted before the front wall — so the wall, which stands
 * `SHED.eaves` *behind* the roof's fascia, was drawn over it and left its own lit top face
 * showing through as a pale band between the two. `over` because a roof is over everything it
 * spans, including the walls holding it up.
 */
export function shedRoofBox(structure: Shed): Box {
  return {
    at: [-SHED.eaves, -SHED.eaves, structure.height],
    size: [
      structure.length + SHED.eaves * 2,
      structure.depth + SHED.eaves * 2,
      SHED.roofThickness,
    ],
    fill: "structureTrim",
  };
}

/**
 * The whole portal: two legs, the beam between them, the trolley and the spreader.
 *
 * All of it travels, so none of it can be baked into the static layer. The first attempt
 * put fixed legs at either end of the portal's travel *and* drew a moving one, which read
 * as three unrelated lampposts standing about in the yard.
 *
 * Both legs matter for a different reason: a portal seen from straight in front is a single
 * vertical line, and one leg gives you exactly that. Two legs at different depths, joined
 * at the top, are what make the beam read as spanning the roads rather than as a post.
 */
export function gantryDrawables(
  world: WorldState,
  structure: Extract<SceneStructure, { kind: "gantry" }>,
  palette: YardPalette,
): Drawable[] {
  const { crane } = world;
  const span = structure.far - structure.near;
  const leg = (depth: number): Box => ({
    at: [-GANTRY.legWidth / 2, depth - GANTRY.legDepth / 2, 0],
    size: [GANTRY.legWidth, GANTRY.legDepth, GANTRY.height],
    fill: "structureTrim",
  });

  /*
   * Five assemblies, not one. Every part of the portal has to be able to interleave with
   * traffic on its own: a train on the eastbound express runs in front of the near leg while
   * one on a loading road runs behind it, and the trolley crosses between them.
   */
  const out: Drawable[] = [
    standingDrawable(crane.portalX, structure.far, [leg(0)]),
    standingDrawable(crane.portalX, crane.trolleyY, [
      {
        at: [
          -GANTRY.trolleyLength / 2,
          -GANTRY.trolleyDepth / 2,
          GANTRY.height - GANTRY.trolleyHeight,
        ],
        size: [GANTRY.trolleyLength, GANTRY.trolleyDepth, GANTRY.trolleyHeight],
        fill: "depot",
      },
    ]),
    standingDrawable(crane.portalX, crane.trolleyY, [
      {
        // `hoistZ` is the underside of the box in the jaws, so the spreader sits one
        // container above it — never below the thing it is carrying. Its own assembly for
        // the same reason: at one place on the ground, height is all that separates them.
        at: [-GANTRY.spreaderLength / 2, -GANTRY.spreaderDepth / 2, spreaderZ(crane)],
        size: [GANTRY.spreaderLength, GANTRY.spreaderDepth, GANTRY.spreaderHeight],
        fill: "metal",
      },
    ]),
    standingDrawable(crane.portalX, structure.near, [leg(0)]),
    standingDrawable(
      crane.portalX,
      structure.far,
      [
        {
          at: [-GANTRY.beamWidth / 2, -span - GANTRY.legDepth / 2, GANTRY.height],
          size: [GANTRY.beamWidth, span + GANTRY.legDepth, GANTRY.beamHeight],
          // Steel, not masonry: `structure` is the sheds' white in the light theme and a
          // beam in it read as a slab laid across the yard rather than as a girder over it.
          fill: "structureTrim",
        },
      ],
      /*
       * A girder over both legs, so it is drawn after both. Keyed on its centre it sat behind
       * the near leg, whose lit top face at the beam's own height then covered two thirds of
       * the beam's near end — the portal read as three pieces of steel that did not meet.
       */
      "over",
    ),
  ];

  if (crane.holding !== null) {
    out.push(
      containerAt(crane.portalX, crane.trolleyY, crane.hoistZ, crane.holding, palette),
    );
  }
  return out;
}

/**
 * The belt, and whatever freight is riding it.
 *
 * A drawable rather than part of the static layer even though the deck never moves: the
 * boxes on it do, and they have to sort against the belt and against everything else at the
 * same depth in one pass. Baking the deck would put it behind a container standing on it.
 *
 * Each box carries its own livery. Passing none was the first version of the pile this
 * replaces, and every container fell back to the metal colour — a grey heap that read as a
 * building rather than as the freight the trains are there for.
 */
export function conveyorDrawables(
  world: WorldState,
  structure: Extract<SceneStructure, { kind: "conveyor" }>,
  palette: YardPalette,
): Drawable[] {
  const [headX, y] = structure.at;
  // Half a pitch of deck either side of the end slots, so a box always stands on belt.
  const deck = standingDrawable(
    headX,
    y,
    [
      {
        at: [-CONVEYOR.PITCH / 2, -CONVEYOR.WIDTH / 2, 0],
        size: [structure.length + CONVEYOR.PITCH, CONVEYOR.WIDTH, CONVEYOR.DECK_Z],
        fill: "structureTrim",
      },
    ],
    /*
     * A floor, so it goes under everything standing on it. Keyed on its centre — which is
     * most of a belt's length east of the head — it was drawn after the container the crane
     * was lowering onto the head slot, and the deck's own top face covered it. The box
     * reappeared the instant it was released and became belt freight drawn later.
     */
    "under",
  );

  return [
    deck,
    // Centred on each box's own x, which is the point the crane reaches for.
    ...world.conveyor.boxes.map((box) =>
      containerAt(box.at, y, CONVEYOR.DECK_Z, box.freight, palette),
    ),
  ];
}
