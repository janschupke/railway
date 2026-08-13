/**
 * Track geometry, in world units.
 *
 * One idea does the work here: a train moves by *arc length*, never by Bézier parameter.
 * A quadratic's `t` is not uniform along its own curve — the first attempt advanced `t`
 * linearly and every locomotive visibly slowed through the middle of a turn and shot out
 * of the end. So each edge is sampled once into an arc-length table at build time and
 * every lookup after that is a search in that table.
 */

/** +x is east, +y is *up-screen* and therefore further away. See view.ts. */
export type Vec2 = readonly [x: number, y: number];

export type Pose = {
  readonly x: number;
  readonly y: number;
  /** Heading, radians, in world space. Rolling stock rotates by this. */
  readonly angle: number;
};

export type EdgeSamples = {
  readonly poses: readonly Pose[];
  /** Arc length at each pose. `cumulative[0]` is 0 and the last entry is `length`. */
  readonly cumulative: readonly number[];
  readonly length: number;
  /**
   * The endpoints, held rather than indexed.
   *
   * `poses[0]` under `noUncheckedIndexedAccess` is `Pose | undefined`, and the guard
   * that satisfies it is a branch no test can ever reach — which then shows up as a
   * coverage shortfall on a line that cannot fail. Naming them costs two fields.
   */
  readonly start: Pose;
  readonly end: Pose;
};

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

const distance = (a: Vec2, b: Vec2): number => Math.hypot(b[0] - a[0], b[1] - a[1]);

/**
 * Samples an edge into an arc-length table.
 *
 * `via` is an absolute quadratic control point, or null for a straight. Absolute rather
 * than an offset because it is what the scene literal reads best as and what
 * `quadraticCurveTo` takes, so no call site has to convert.
 *
 * A straight is sampled at its two endpoints and nothing more: the search below is exact
 * for it, and spending twenty-four samples to describe a line puts twenty-two needless
 * entries in every frame's working set.
 */
export function sampleEdge(
  from: Vec2,
  to: Vec2,
  via: Vec2 | null,
  count: number,
): EdgeSamples {
  const steps = via === null ? 1 : Math.max(1, Math.floor(count));
  const poses: Pose[] = [];
  const cumulative: number[] = [];
  let travelled = 0;
  let previous: Vec2 = from;

  for (let index = 0; index <= steps; index++) {
    const t = index / steps;
    const point: Vec2 =
      via === null
        ? [lerp(from[0], to[0], t), lerp(from[1], to[1], t)]
        : quadratic(from, via, to, t);

    if (index > 0) travelled += distance(previous, point);
    previous = point;

    poses.push({ x: point[0], y: point[1], angle: headingAt(from, via, to, t) });
    cumulative.push(travelled);
  }

  return {
    poses,
    cumulative,
    length: travelled,
    start: poses[0]!,
    end: poses[poses.length - 1]!,
  };
}

function quadratic(p0: Vec2, control: Vec2, p1: Vec2, t: number): Vec2 {
  const inverse = 1 - t;
  const a = inverse * inverse;
  const b = 2 * inverse * t;
  const c = t * t;
  return [
    a * p0[0] + b * control[0] + c * p1[0],
    a * p0[1] + b * control[1] + c * p1[1],
  ];
}

/**
 * The tangent, analytically rather than by finite difference.
 *
 * A difference estimate is degenerate at both ends of the curve, which is precisely
 * where a train sits while it waits at a signal — the locomotive flipped through a right
 * angle on the frame it stopped.
 */
function headingAt(p0: Vec2, control: Vec2 | null, p1: Vec2, t: number): number {
  if (control === null) return Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
  const inverse = 1 - t;
  const dx = 2 * inverse * (control[0] - p0[0]) + 2 * t * (p1[0] - control[0]);
  const dy = 2 * inverse * (control[1] - p0[1]) + 2 * t * (p1[1] - control[1]);
  // A control point sitting exactly on the chord's midpoint makes both zero at t = 0.5.
  if (dx === 0 && dy === 0) return Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
  return Math.atan2(dy, dx);
}

/**
 * The pose at an arc length along a sampled edge.
 *
 * Clamped at both ends rather than extrapolated: a train that overruns its path by a
 * wagon length must stop at the end of the rails, not carry on across open ground.
 */
export function poseAtDistance(samples: EdgeSamples, at: number): Pose {
  const { poses, cumulative, length } = samples;
  if (at <= 0) return samples.start;
  if (at >= length) return samples.end;

  /*
   * Binary search for the segment holding `at`. Linear was fine at the twenty-four
   * samples a curve gets and is not at the count a wide viewport asks for, and this runs
   * once per vehicle per frame — roughly twenty times, times sixty.
   */
  let low = 0;
  let high = cumulative.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (cumulative[mid]! <= at) low = mid;
    else high = mid;
  }

  const startAt = cumulative[low]!;
  const endAt = cumulative[high]!;
  const a = poses[low]!;
  const b = poses[high]!;
  const span = endAt - startAt;
  // Two coincident samples: possible on a curve whose control point sits on an endpoint.
  const t = span > 0 ? (at - startAt) / span : 0;

  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    angle: lerpAngle(a.angle, b.angle, t),
  };
}

/**
 * Interpolates the short way round.
 *
 * A plain lerp from 179° to -179° sweeps 358° the wrong way, which on a train is a full
 * spin inside one frame. Only the reversing curve at the depot throat crosses ±π, and it
 * did exactly that.
 */
export function lerpAngle(a: number, b: number, t: number): number {
  const twoPi = Math.PI * 2;
  let delta = (b - a) % twoPi;
  if (delta > Math.PI) delta -= twoPi;
  if (delta < -Math.PI) delta += twoPi;
  return a + delta * t;
}
