/**
 * One frame.
 *
 * The static layer is blitted, then everything that can move or be moved in front of is
 * drawn in **one depth-sorted pass**. That is the change that lets a locomotive stand
 * inside the engine shed: the shed's front wall is a drawable at its own depth rather than
 * part of the baked background, so a train further back is painted before it and a train in
 * front of it after.
 *
 * The sort is per *drawable*, not per train. The previous version sorted whole trains by
 * their locomotive's depth, which cannot be right for a rake straddling a crossover — half
 * of it is on one road and half on the next, and its wagons have to sort against other
 * traffic independently of the engine pulling them.
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
  drawBoxes,
  drawRibs,
  drawRope,
  drawShadow,
  visible,
  type Cargo,
} from "./draw-box";
import type { Pose } from "./geometry";
import { poseAlong } from "./graph";
import type { YardPalette } from "./palette";
import type { RailScene, SceneStructure } from "./scene";
import type { TrainState, WorldState } from "./simulation";
import { spreaderZ } from "./crane";
import { aspectOf } from "./traffic";
import { toScreenX, toScreenY, type ViewTransform } from "./view";
import { YARD } from "./config";

export type Layer = {
  readonly ctx: CanvasRenderingContext2D;
  readonly image: CanvasImageSource;
};

/**
 * Anything drawn in the sorted pass.
 *
 * `depth` and `x` are the sort key; `boxes` are in the frame `pose` establishes. A vehicle
 * carries a `nose` offset because its spec is written forward from the rear coupling while
 * the simulation tracks the leading one.
 */
type Drawable = {
  readonly depth: number;
  readonly x: number;
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

const vehicle = (
  pose: Pose,
  boxes: readonly Box[],
  nose: number,
  spec: readonly [number, number],
  cargo: Cargo | null,
  ribs: number,
  ribbed: Box | null,
): Drawable => ({
  depth: pose.y,
  x: pose.x,
  pose,
  boxes,
  nose,
  cargo,
  shadow: spec,
  ribbed,
  ribs,
});

const standing = (x: number, y: number, boxes: readonly Box[]): Drawable => ({
  depth: y,
  x,
  pose: { x, y, angle: 0 },
  boxes,
  nose: 0,
  cargo: null,
  shadow: null,
  ribbed: null,
  ribs: 0,
});

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

    const loaded = wagon.cargo !== null;
    const cargo: Cargo | null = loaded
      ? { colour: palette.freight[wagon.cargo!] ?? palette.metal, ribs: wagon.ribs }
      : null;
    const container: Box = {
      at: CONTAINER.at,
      size: CONTAINER.size,
      fill: "cargo",
    };

    out.push(
      vehicle(
        pose,
        loaded ? [...WAGON.boxes, container] : WAGON.boxes,
        WAGON.length,
        [WAGON.length, WAGON.width],
        cargo,
        wagon.ribs,
        loaded ? container : null,
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
 * A shed's front wall, as a lintel and a row of piers.
 *
 * Piers rather than a hole punched through a solid wall: cutting one would need
 * `globalCompositeOperation`, which is a second rendering mode to reason about and a new op
 * for the recording fake to learn. `bays + 1` uprights between `bays` doorways is the same
 * picture, in the same box walker, at five fills.
 *
 * Measured from the **front plane**, which is where the drawable's pose already puts it.
 * They were measured from the shed's centre as well, so the offset was applied twice and
 * the wall stood a whole depth in front of the building — a roof hovering with a gap of
 * clear ground beneath it, which is most of what "roofs aren't attached to walls" was.
 */
export function shedFrontBoxes(
  structure: Extract<SceneStructure, { kind: "shed" }>,
): Box[] {
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
    out.push({
      ...standing(crane.portalX, crane.trolleyY, [
        {
          at: [-CONTAINER.size[0] / 2, -CONTAINER.size[1] / 2, crane.hoistZ],
          size: CONTAINER.size,
          fill: "cargo",
        },
      ]),
      cargo: { colour: palette.freight[crane.holding] ?? palette.metal, ribs: 0 },
    });
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
    },
  ]);

  return [
    deck,
    ...world.conveyor.boxes.map((box) => ({
      // Centred on the box's own x, which is the point the crane reaches for.
      ...standing(box.at, y, [
        {
          at: [-CONTAINER.size[0] / 2, -CONTAINER.size[1] / 2, CONVEYOR.DECK_Z],
          size: CONTAINER.size,
          fill: "cargo" as const,
        },
      ]),
      cargo: { colour: palette.freight[box.colour] ?? palette.metal, ribs: 0 },
    })),
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
        standing(structure.at, road.y - structure.depth / 2, shedFrontBoxes(structure)),
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

  const onCamera = drawables.filter((drawable) => {
    const screen = toScreenX(view, drawable.x, drawable.depth);
    return screen > -VIEW.CULL_MARGIN_PX && screen < view.width + VIEW.CULL_MARGIN_PX;
  });

  /*
   * Shadows first, as their own pass. They lie flat on the ground, so nothing can occlude
   * them — and interleaving them per vehicle, which is what the first version did, lets a
   * near train's shadow land on top of a far train's body. Sorted along with everything
   * else so that two overlapping shadows stack the same way their vehicles do.
   */
  // Furthest first, and x breaking the tie so two things at the same depth are stable.
  onCamera.sort((a, b) => b.depth - a.depth || a.x - b.x);

  for (const drawable of onCamera) {
    if (!drawable.shadow) continue;
    drawShadow(
      ctx,
      view,
      drawable.pose,
      drawable.shadow[0],
      drawable.shadow[1],
      palette,
    );
  }

  for (const drawable of onCamera) {
    drawBoxes(
      ctx,
      view,
      drawable.pose,
      drawable.boxes,
      palette,
      drawable.nose,
      drawable.cargo,
    );
    if (drawable.ribbed) {
      drawRibs(
        ctx,
        view,
        drawable.pose,
        drawable.ribbed,
        palette,
        drawable.nose,
        drawable.ribs,
      );
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
