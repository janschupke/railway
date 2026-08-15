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

import { VIEW, YARD } from "./config";
import { GANTRY, SIGNAL } from "./sprites";
import { drawBox, drawRibs, drawRope, drawShadow, visible } from "./draw-box";
import {
  assemblyDepth,
  standingDrawable,
  type Contact,
  type Drawable,
} from "./drawable";
import { localToWorld } from "./geometry";
import { placeTrain } from "./place-train";
import type { YardPalette } from "./palette";
import type { RailScene } from "./scene-types";
import {
  conveyorDrawables,
  gantryDrawables,
  shedFrontBoxes,
  shedRoofBox,
} from "./structures";
import type { WorldState } from "./world-state";
import { spreaderZ } from "./crane";
import { aspectOf } from "./traffic";
import { toScreenX, toScreenY, viewDepth, type ViewTransform } from "./view";

export type Layer = {
  readonly ctx: CanvasRenderingContext2D;
  readonly image: CanvasImageSource;
};

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
    const size =
      YARD.SMOKE_RADIUS[0] + (YARD.SMOKE_RADIUS[1] - YARD.SMOKE_RADIUS[0]) * life;
    // `visible`, not the same comparison spelled out again — it was already imported here.
    if (!visible(size, view.scale)) continue;
    const radius = size * view.scale;
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
      const front = road.y - structure.depth / 2;
      drawables.push(standingDrawable(structure.at, front, shedFrontBoxes(structure)));
      drawables.push(
        standingDrawable(structure.at, front, [shedRoofBox(structure)], "over"),
      );
      continue;
    }
    if (structure.kind === "gantry")
      drawables.push(...gantryDrawables(world, structure, palette));
    if (structure.kind === "conveyor")
      drawables.push(...conveyorDrawables(world, structure, palette));
    if (structure.kind === "signal") {
      drawables.push(
        standingDrawable(structure.at[0], structure.at[1], [
          {
            at: [0, -SIGNAL.postDepth / 2, 0],
            size: [SIGNAL.postWidth, SIGNAL.postDepth, SIGNAL.height],
            fill: "structureTrim",
          },
        ]),
      );
    }
  }

  const onCamera: Array<{ key: number; drawable: Drawable }> = [];
  const contacts: Contact[] = [];

  for (const drawable of drawables) {
    const screen = toScreenX(view, drawable.pose.x, drawable.pose.y);
    if (screen <= -VIEW.CULL_MARGIN_PX || screen >= view.width + VIEW.CULL_MARGIN_PX) {
      continue;
    }
    onCamera.push({
      key: assemblyDepth(drawable.pose, drawable.boxes, drawable.nose, drawable.order),
      drawable,
    });
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
  }

  // Furthest from the camera first, which is what a painter's algorithm is.
  onCamera.sort((a, b) => b.key - a.key);
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

  for (const { drawable } of onCamera) {
    // Boxes in the order the assembly lists them, which is bottom up. See `Drawable`.
    for (const box of drawable.boxes) {
      drawBox(ctx, view, drawable.pose, box, palette, drawable.nose, drawable.cargo);
      if (box === drawable.ribbed && drawable.ribs > 0) {
        drawRibs(ctx, view, drawable.pose, box, palette, drawable.nose, drawable.ribs);
      }
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
