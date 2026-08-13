/**
 * One frame.
 *
 * The static layer is blitted, then everything that can move or be moved in front of is
 * drawn in **one depth-sorted pass**. That is the change that lets a locomotive stand
 * inside the engine shed: the shed's front wall is a drawable at its own depth rather than
 * part of the baked background, so a train further back is painted before it and a train in
 * front of it after.
 *
 * The sort is per **box**, and it is keyed on `viewDepth` rather than on a road's depth.
 *
 * Both halves of that were wrong and both showed. Keying on `y` alone threw away the height
 * term, so two things standing at one place on the ground sorted equal and insertion order
 * decided between them: a container's lit top face was painted over the spreader holding it,
 * and the belt deck over the container being lowered onto the belt — which is the flicker as
 * the box was released and became a belt box drawn after the deck instead of before it.
 * Sorting whole drawables was the other half: a gantry is legs at two depths joined by a beam
 * over both, and no single number orders it against a train passing between them.
 *
 * Per box also gets a rake straddling a crossover right, which is what the previous version
 * was reaching for: half of it is on one road and half on the next, and its wagons sort
 * against other traffic independently of the engine pulling them.
 */

import {
  CONTAINER,
  CONVEYOR,
  GANTRY,
  LOCOMOTIVE,
  SHED,
  SIGNAL,
  VIEW,
  WAGON,
  type Box,
} from "./config";
import {
  drawBox,
  drawRibs,
  drawRope,
  drawShadow,
  visible,
  type Cargo,
} from "./draw-box";
import { localToWorld, type Pose } from "./geometry";
import { poseAlong } from "./graph";
import type { YardPalette } from "./palette";
import type { RailScene, SceneStructure } from "./scene";
import type { TrainState, WorldState } from "./simulation";
import type { Freight } from "./conveyor";
import { spreaderZ } from "./crane";
import { aspectOf } from "./traffic";
import { toScreenX, toScreenY, viewDepth, type ViewTransform } from "./view";
import { YARD } from "./config";

export type Layer = {
  readonly ctx: CanvasRenderingContext2D;
  readonly image: CanvasImageSource;
};

/**
 * A group of boxes sharing one pose: a vehicle, a building, a piece of machinery.
 *
 * A convenience for building the frame rather than a unit of sorting — the sort takes the
 * boxes apart again. A vehicle carries a `nose` offset because its spec is written forward
 * from the rear coupling while the simulation tracks the leading one.
 */
type Drawable = {
  readonly pose: Pose;
  readonly boxes: readonly Box[];
  readonly nose: number;
  readonly cargo: Cargo | null;
  /** Set for rolling stock: the footprint that gets a contact shadow. */
  readonly shadow: readonly [length: number, width: number] | null;
  /** Set for a loaded container: the box to draw corrugation on. */
  readonly ribbed: Box | null;
  readonly ribs: number;
};

/** One box, posed, with the distance from the camera the painter orders it by. */
type Solid = {
  readonly key: number;
  readonly pose: Pose;
  readonly box: Box;
  readonly nose: number;
  readonly cargo: Cargo | null;
  /** Corrugation, for a container. Zero for every other solid in the yard. */
  readonly ribs: number;
};

/** A contact shadow, sorted alongside the solids so two of them stack as their bodies do. */
type Contact = {
  readonly key: number;
  readonly pose: Pose;
  readonly size: readonly [length: number, width: number];
};

const vehicle = (
  pose: Pose,
  boxes: readonly Box[],
  nose: number,
  spec: readonly [number, number],
  cargo: Cargo | null,
  ribs: number,
  ribbed: Box | null,
): Drawable => ({
  pose,
  boxes,
  nose,
  cargo,
  shadow: spec,
  ribbed,
  ribs,
});

const standing = (x: number, y: number, boxes: readonly Box[]): Drawable => ({
  pose: { x, y, angle: 0 },
  boxes,
  nose: 0,
  cargo: null,
  shadow: null,
  ribbed: null,
  ribs: 0,
});

/**
 * How far a box is from the camera.
 *
 * Its centre, for anything roughly as deep as it is wide — which is every solid in the yard
 * but the three that declare an `order`. Those take an extreme corner instead: see the field
 * on `Box` for why a beam, a roof and a belt deck cannot be ordered by a point.
 *
 * Exported because a sort tested through a rendered frame is tested by accident: the
 * recording says what was painted, not which of two things the painter thought was nearer.
 */
export function boxDepth(pose: Pose, box: Box, nose: number = 0): number {
  const [length, width, height] = box.size;
  const west = box.at[0] - nose;
  const bottom = box.at[2];

  if (box.order === undefined) {
    const [x, y] = localToWorld(pose, west + length / 2, box.at[1] + width / 2);
    return viewDepth(x, y, bottom + height / 2);
  }

  const over = box.order === "over";
  let key = over ? Infinity : -Infinity;
  for (const forward of [west, west + length]) {
    for (const left of [box.at[1], box.at[1] + width]) {
      const [x, y] = localToWorld(pose, forward, left);
      for (const z of [bottom, bottom + height]) {
        const corner = viewDepth(x, y, z);
        key = over ? Math.min(key, corner) : Math.max(key, corner);
      }
    }
  }
  return key;
}

/** What a container is painted in: its own livery, and its own corrugation. */
const liveryOf = (palette: YardPalette, freight: Freight): Cargo => ({
  colour: palette.freight[freight.colour] ?? palette.metal,
  ribs: freight.ribs,
});

/**
 * A container standing somewhere that is not a wagon: the belt, or the crane's spreader.
 *
 * Ribbed like the ones on the flats, which they were not — `conveyorDrawables` and the
 * carried box both passed no corrugation at all, so freight acquired its panels on being set
 * down and lost them again on being picked up. They travel with the box now.
 */
function containerAt(
  x: number,
  y: number,
  z: number,
  freight: Freight,
  palette: YardPalette,
): Drawable {
  const box: Box = {
    at: [-CONTAINER.size[0] / 2, -CONTAINER.size[1] / 2, z],
    size: CONTAINER.size,
    fill: "cargo",
  };
  return {
    ...standing(x, y, [box]),
    cargo: liveryOf(palette, freight),
    ribbed: box,
    ribs: freight.ribs,
  };
}

/**
 * Where a train's vehicles are this frame.
 *
 * `alpha` carries the leftover of the fixed timestep, so the drawn position is interpolated
 * forward from the last simulated one and a 120 Hz display gets smooth motion out of a
 * 50 Hz simulation.
 */
function placeTrain(
  world: WorldState,
  train: TrainState,
  palette: YardPalette,
  alpha: number,
): Drawable[] {
  const nose = train.distance + train.speed * alpha * (20 / 1000);
  const out: Drawable[] = [];

  for (let index = train.wagons.length - 1; index >= 0; index--) {
    const wagon = train.wagons[index]!;
    const at =
      nose -
      LOCOMOTIVE.length -
      YARD.WAGON_GAP -
      index * (WAGON.length + YARD.WAGON_GAP);
    const pose = poseAlong(world.graph, train.path, at);
    if (!pose) continue;

    const { cargo } = wagon;
    const container: Box = {
      at: CONTAINER.at,
      size: CONTAINER.size,
      fill: "cargo",
    };

    out.push(
      vehicle(
        pose,
        cargo ? [...WAGON.boxes, container] : WAGON.boxes,
        WAGON.length,
        [WAGON.length, WAGON.width],
        cargo && liveryOf(palette, cargo),
        cargo?.ribs ?? 0,
        cargo ? container : null,
      ),
    );
  }

  const pose = poseAlong(world.graph, train.path, nose);
  if (pose) {
    out.push(
      vehicle(
        pose,
        LOCOMOTIVE.boxes,
        LOCOMOTIVE.length,
        [LOCOMOTIVE.length, LOCOMOTIVE.width],
        null,
        0,
        null,
      ),
    );
  }
  return out;
}

/**
 * The parts of a shed that enter the depth sort: its front wall, and its roof.
 *
 * The front wall is a lintel and a row of piers. Piers rather than a hole punched through a
 * solid wall: cutting one would need `globalCompositeOperation`, which is a second rendering
 * mode to reason about and a new op for the recording fake to learn. `bays + 1` uprights
 * between `bays` doorways is the same picture, in the same box walker, at five fills.
 *
 * All of it is measured from the **front plane**, which is where the drawable's pose already
 * puts it. The wall was measured from the shed's centre as well, so the offset went on twice
 * and it stood a whole depth in front of the building.
 *
 * The roof is here rather than in the static layer, and that is the rest of "the roof isn't
 * touching the walls". Baked, it was painted before the front wall — so the wall, which
 * stands `SHED.eaves` *behind* the roof's fascia, was drawn over it, and the wall's own lit
 * top face landed in the gap as a pale band between the two. It is `over` because a roof is
 * over everything it spans, including the walls holding it up.
 */
export function shedSortedBoxes(
  structure: Extract<SceneStructure, { kind: "shed" }>,
): Box[] {
  const boxes: Box[] = [
    {
      at: [0, 0, SHED.doorHeight],
      size: [structure.length, SHED.wallThickness, structure.height - SHED.doorHeight],
      fill: "structure",
    },
    {
      at: [-SHED.eaves, -SHED.eaves, structure.height],
      size: [
        structure.length + SHED.eaves * 2,
        structure.depth + SHED.eaves * 2,
        SHED.roofThickness,
      ],
      fill: "structureTrim",
      order: "over",
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
function gantryDrawables(
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

  const out: Drawable[] = [
    // The far leg and the beam sort with the back of the yard; the near leg with the front.
    standing(crane.portalX, structure.far, [
      leg(0),
      {
        at: [-GANTRY.beamWidth / 2, -span - GANTRY.legDepth / 2, GANTRY.height],
        size: [GANTRY.beamWidth, span + GANTRY.legDepth, GANTRY.beamHeight],
        // Steel, not masonry: `structure` is the sheds' white in the light theme and a
        // beam in it read as a slab laid across the yard rather than as a girder over it.
        fill: "structureTrim",
        /*
         * A girder over both legs, so it is drawn after both. Keyed on its centre it sat
         * behind the near leg, whose lit top face at the beam's own height then covered two
         * thirds of the beam's near end — the portal read as three pieces of steel that did
         * not meet.
         */
        order: "over",
      },
    ]),
    standing(crane.portalX, crane.trolleyY, [
      {
        at: [
          -GANTRY.trolleyLength / 2,
          -GANTRY.trolleyDepth / 2,
          GANTRY.height - GANTRY.trolleyHeight,
        ],
        size: [GANTRY.trolleyLength, GANTRY.trolleyDepth, GANTRY.trolleyHeight],
        fill: "depot",
      },
      {
        // `hoistZ` is the underside of the box in the jaws, so the spreader sits one
        // container above it — never below the thing it is carrying.
        at: [-GANTRY.spreaderLength / 2, -GANTRY.spreaderDepth / 2, spreaderZ(crane)],
        size: [GANTRY.spreaderLength, GANTRY.spreaderDepth, GANTRY.spreaderHeight],
        fill: "metal",
      },
    ]),
    standing(crane.portalX, structure.near, [leg(0)]),
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
function conveyorDrawables(
  world: WorldState,
  structure: Extract<SceneStructure, { kind: "conveyor" }>,
  palette: YardPalette,
): Drawable[] {
  const [headX, y] = structure.at;
  // Half a pitch of deck either side of the end slots, so a box always stands on belt.
  const deck = standing(headX, y, [
    {
      at: [-CONVEYOR.PITCH / 2, -CONVEYOR.WIDTH / 2, 0],
      size: [structure.length + CONVEYOR.PITCH, CONVEYOR.WIDTH, CONVEYOR.DECK_Z],
      fill: "structureTrim",
      /*
       * A floor, so it goes under everything standing on it. Keyed on its centre — which is
       * most of a belt's length east of the head — it was drawn after the container the
       * crane was lowering onto the head slot, and the deck's own top face covered it. The
       * box reappeared the instant it was released and became belt freight drawn later.
       */
      order: "under",
    },
  ]);

  return [
    deck,
    // Centred on each box's own x, which is the point the crane reaches for.
    ...world.conveyor.boxes.map((box) =>
      containerAt(box.at, y, CONVEYOR.DECK_Z, box.freight, palette),
    ),
  ];
}

function drawSmoke(
  ctx: CanvasRenderingContext2D,
  world: WorldState,
  view: ViewTransform,
  palette: YardPalette,
): void {
  ctx.save();
  ctx.fillStyle = palette.smoke;
  for (const puff of world.puffs) {
    const life = puff.ageMs / puff.lifeMs;
    const radius =
      (YARD.SMOKE_RADIUS[0] + (YARD.SMOKE_RADIUS[1] - YARD.SMOKE_RADIUS[0]) * life) *
      view.scale;
    if (radius < VIEW.MIN_FEATURE_PX) continue;
    ctx.globalAlpha = 1 - life;
    ctx.beginPath();
    ctx.arc(
      toScreenX(view, puff.x, puff.y),
      toScreenY(view, puff.y, puff.z),
      radius,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
  ctx.restore();
}

function drawSignals(
  ctx: CanvasRenderingContext2D,
  world: WorldState,
  scene: RailScene,
  view: ViewTransform,
  palette: YardPalette,
): void {
  if (!visible(SIGNAL.lampRadius * 2, view.scale)) return;
  for (const structure of scene.structures) {
    if (structure.kind !== "signal") continue;
    const aspect = aspectOf(world.graph, world.occupancy, structure.guards);
    ctx.fillStyle =
      aspect === "stop"
        ? palette.signalStop
        : aspect === "caution"
          ? palette.signalCaution
          : palette.signalGo;
    ctx.beginPath();
    ctx.arc(
      toScreenX(view, structure.at[0], structure.at[1]),
      toScreenY(view, structure.at[1], SIGNAL.height),
      SIGNAL.lampRadius * view.scale,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
}

export function drawFrame(
  ctx: CanvasRenderingContext2D,
  layer: Layer | null,
  world: WorldState,
  view: ViewTransform,
  palette: YardPalette,
  alpha: number,
): void {
  ctx.clearRect(0, 0, view.width, view.height);
  if (layer) ctx.drawImage(layer.image, 0, 0, view.width, view.height);

  const scene = world.graph.scene;
  const drawables: Drawable[] = [];

  for (const train of world.trains)
    drawables.push(...placeTrain(world, train, palette, alpha));

  for (const structure of scene.structures) {
    if (structure.kind === "shed") {
      const road = world.graph.roads.get(structure.road);
      if (!road) continue;
      drawables.push(
        standing(
          structure.at,
          road.y - structure.depth / 2,
          shedSortedBoxes(structure),
        ),
      );
      continue;
    }
    if (structure.kind === "gantry")
      drawables.push(...gantryDrawables(world, structure, palette));
    if (structure.kind === "conveyor")
      drawables.push(...conveyorDrawables(world, structure, palette));
    if (structure.kind === "signal") {
      drawables.push(
        standing(structure.at[0], structure.at[1], [
          {
            at: [0, -SIGNAL.postDepth / 2, 0],
            size: [SIGNAL.postWidth, SIGNAL.postDepth, SIGNAL.height],
            fill: "structureTrim",
          },
        ]),
      );
    }
  }

  const solids: Solid[] = [];
  const contacts: Contact[] = [];

  for (const drawable of drawables) {
    const screen = toScreenX(view, drawable.pose.x, drawable.pose.y);
    if (screen <= -VIEW.CULL_MARGIN_PX || screen >= view.width + VIEW.CULL_MARGIN_PX) {
      continue;
    }
    if (drawable.shadow) {
      // Keyed where the shadow actually lies, which is half a vehicle behind the pose: the
      // pose tracks the leading coupling, and a rake on a curve is a dozen units of depth
      // between the two.
      const [cx, cy] = localToWorld(drawable.pose, -drawable.shadow[0] / 2, 0);
      contacts.push({
        key: viewDepth(cx, cy),
        pose: drawable.pose,
        size: drawable.shadow,
      });
    }
    for (const box of drawable.boxes) {
      solids.push({
        key: boxDepth(drawable.pose, box, drawable.nose),
        pose: drawable.pose,
        box,
        nose: drawable.nose,
        cargo: drawable.cargo,
        ribs: box === drawable.ribbed ? drawable.ribs : 0,
      });
    }
  }

  // Furthest from the camera first, which is what a painter's algorithm is.
  solids.sort((a, b) => b.key - a.key);
  contacts.sort((a, b) => b.key - a.key);

  /*
   * Shadows first, as their own pass. They lie flat on the ground, so nothing can occlude
   * them — and interleaving them per vehicle, which is what the first version did, lets a
   * near train's shadow land on top of a far train's body. Sorted along with everything
   * else so that two overlapping shadows stack the same way their vehicles do.
   */
  for (const contact of contacts) {
    drawShadow(ctx, view, contact.pose, contact.size[0], contact.size[1], palette);
  }

  for (const solid of solids) {
    drawBox(ctx, view, solid.pose, solid.box, palette, solid.nose, solid.cargo);
    if (solid.ribs > 0) {
      drawRibs(ctx, view, solid.pose, solid.box, palette, solid.nose, solid.ribs);
    }
  }

  // The hoist rope, after the gantry so it hangs in front of the beam it comes off.
  const gantry = scene.structures.find((structure) => structure.kind === "gantry");
  if (gantry?.kind === "gantry") {
    drawRope(
      ctx,
      view,
      [world.crane.portalX, world.crane.trolleyY],
      GANTRY.height - GANTRY.trolleyHeight,
      spreaderZ(world.crane) + GANTRY.spreaderHeight,
      palette,
    );
  }

  drawSmoke(ctx, world, view, palette);
  drawSignals(ctx, world, scene, view, palette);
}
