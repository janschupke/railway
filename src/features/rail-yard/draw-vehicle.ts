/**
 * Rolling stock, drawn from the sprite specs in config.ts.
 *
 * Everything here works in *vehicle-local* units — x forward from the rear coupling, y up
 * from the rail head — because that is the frame the specs are written in and the frame a
 * person editing them thinks in. The canvas transform does the conversion once per
 * vehicle, including the y flip, so no spec ever has to know that screen y points down.
 */

import { CONTAINER, VIEW, type Part, type VehicleSpec, type WheelSet } from "./config";
import type { Pose } from "./geometry";
import type { YardPalette } from "./palette";
import { toScreenX, toScreenY, type ViewTransform } from "./view";

export type Cargo = { readonly colour: string; readonly ribs: number };

/** Below this the feature lands on its neighbour's pixel and only costs fill rate. */
const visible = (size: number, scale: number): boolean =>
  size * scale >= VIEW.MIN_FEATURE_PX;

function fillPart(
  ctx: CanvasRenderingContext2D,
  part: Part,
  palette: YardPalette,
  scale: number,
): void {
  const [x, y, width, height] = part.rect;
  if (!visible(height, scale)) return;

  ctx.fillStyle = part.fill === "cargo" ? palette.metal : palette[part.fill];
  if (part.radius !== undefined && visible(part.radius * 4, scale)) {
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, part.radius);
    ctx.fill();
    return;
  }
  ctx.fillRect(x, y, width, height);
}

function drawWheels(
  ctx: CanvasRenderingContext2D,
  set: WheelSet,
  palette: YardPalette,
  scale: number,
): void {
  if (!visible(set.radius * 2, scale)) return;

  for (let index = 0; index < set.count; index++) {
    const cx = set.at + index * set.pitch;
    ctx.fillStyle = palette.metal;
    ctx.beginPath();
    ctx.arc(cx, set.radius, set.radius, 0, Math.PI * 2);
    ctx.fill();

    // The hub, as a lighter core rather than a second token: it only has to break up
    // the disc, and at this size a stroked rim disappears into the fill anyway.
    if (!visible(set.radius, scale)) continue;
    ctx.fillStyle = palette.locoTrim;
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    ctx.arc(cx, set.radius, set.radius * 0.42, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

/**
 * The box on a loaded wagon.
 *
 * Corrugation is the body colour under a low alpha rather than a second palette entry:
 * the ribs have to work against six different container colours in two themes, and any
 * fixed second colour is wrong against at least one of them.
 */
function drawContainer(
  ctx: CanvasRenderingContext2D,
  cargo: Cargo,
  palette: YardPalette,
  scale: number,
): void {
  const [x, y, width, height] = CONTAINER.rect;
  if (!visible(height, scale)) return;

  ctx.fillStyle = cargo.colour;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, CONTAINER.radius);
  ctx.fill();

  if (!visible(CONTAINER.ribWidth * 2, scale)) return;

  ctx.save();
  ctx.globalAlpha = CONTAINER.ribAlpha;
  ctx.fillStyle = palette.locoTrim;
  // The door end, one shade down, so a container reads as having a front and a back.
  ctx.fillRect(x + width - CONTAINER.doorWidth, y, CONTAINER.doorWidth, height);

  ctx.strokeStyle = palette.locoTrim;
  ctx.lineWidth = CONTAINER.ribWidth;
  const usable = width - CONTAINER.doorWidth;
  for (let rib = 1; rib <= cargo.ribs; rib++) {
    const at = x + (usable * rib) / (cargo.ribs + 1);
    ctx.beginPath();
    ctx.moveTo(at, y + 1);
    ctx.lineTo(at, y + height - 1);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * The contact shadow, in screen space rather than vehicle space.
 *
 * A flat ellipse under the wheels, and deliberately not `shadowBlur` — that is the most
 * expensive operation the 2D context has, and it would dominate the frame on a phone for
 * a cue this sells just as well.
 */
export function drawShadow(
  ctx: CanvasRenderingContext2D,
  view: ViewTransform,
  pose: Pose,
  length: number,
  palette: YardPalette,
): void {
  const halfWidth = (length / 2) * view.scale;
  if (halfWidth < VIEW.MIN_FEATURE_PX) return;

  ctx.save();
  ctx.fillStyle = palette.shadow;
  ctx.beginPath();
  ctx.ellipse(
    toScreenX(view, pose.x) - Math.cos(pose.angle) * halfWidth,
    toScreenY(view, pose.y),
    halfWidth,
    Math.max(VIEW.MIN_FEATURE_PX, VIEW.SHADOW_HEIGHT * view.scale),
    -pose.angle,
    0,
    Math.PI * 2,
  );
  ctx.fill();
  ctx.restore();
}

/**
 * Draws one vehicle with its nose at `pose`.
 *
 * The nose rather than the centre, because that is what the simulation tracks: a train's
 * `distance` is the arc length of its locomotive's leading coupling, and every wagon is
 * placed by subtracting from it.
 */
export function drawVehicle(
  ctx: CanvasRenderingContext2D,
  spec: VehicleSpec,
  view: ViewTransform,
  pose: Pose,
  palette: YardPalette,
  cargo: Cargo | null,
): void {
  ctx.save();
  ctx.translate(toScreenX(view, pose.x), toScreenY(view, pose.y));
  // Negated: a world heading turns anticlockwise, screen y points the other way.
  ctx.rotate(-pose.angle);
  ctx.scale(view.scale, -view.scale);
  // Local x = length is the nose, and the nose is where the pose put us.
  ctx.translate(-spec.length, 0);

  for (const part of spec.parts) fillPart(ctx, part, palette, view.scale);
  for (const set of spec.bogies) drawWheels(ctx, set, palette, view.scale);

  if (spec.chimney && visible(spec.chimney.width, view.scale)) {
    ctx.fillStyle = palette.metal;
    ctx.fillRect(
      spec.chimney.at - spec.chimney.width / 2,
      spec.chimney.base,
      spec.chimney.width,
      spec.chimney.height,
    );
  }

  if (cargo) drawContainer(ctx, cargo, palette, view.scale);

  ctx.restore();
}
