/**
 * Track geometry, in world units.
 *
 * Two ideas do the work here.
 *
 * A train moves by *arc length*, never by curve parameter. A cubic's `t` is not uniform
 * along its own curve — the first attempt advanced `t` linearly and every locomotive
 * visibly slowed through the middle of a turn and shot out of the end. So each edge is
 * sampled once into an arc-length table at build time and every lookup after that is a
 * search in that table.
 *
 * And every edge starts and ends *horizontal*. A run is a straight along one road; a
 * crossover is a cubic Hermite whose tangents at both ends point along x. That is not a
 * style choice — it is what makes two edges meeting at a node agree on a heading to
 * machine precision, which the hand-authored quadratic control points it replaces did
 * not: they left a 128.7 degree snap at one junction and a locomotive spun through it in
 * a single frame.
 */

/** +x is east, +y is *away from the camera*. See view.ts for how that is projected. */
export type Vec2 = readonly [x: number, y: number];

export type Pose = {
  readonly x: number;
  readonly y: number;
  /** Heading, radians, on the ground plane. Rolling stock is oriented by this. */
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
 * A straight run along one road.
 *
 * Sampled at its two endpoints and nothing more: the search in `poseAtDistance` is exact
 * for a line, and spending twenty-four samples to describe one puts twenty-two needless
 * entries in every frame's working set.
 */
export function sampleRun(from: Vec2, to: Vec2): EdgeSamples {
  const angle = Math.atan2(to[1] - from[1], to[0] - from[0]);
  const poses: Pose[] = [
    { x: from[0], y: from[1], angle },
    { x: to[0], y: to[1], angle },
  ];
  const length = distance(from, to);
  return {
    poses,
    cumulative: [0, length],
    length,
    start: poses[0]!,
    end: poses[1]!,
  };
}

/**
 * A crossover between two roads: a cubic Hermite with horizontal tangents at both ends.
 *
 * The tangent magnitude is taken from the *run* rather than the drop, so a long shallow
 * crossover and a short steep one are the same curve stretched — which is what makes the
 * blade angle a function of the run-to-drop ratio, and therefore something scene.test.ts
 * can hold to a real turnout figure instead of to a number somebody liked the look of.
 *
 * The 0.62 is the one shape constant. At 1.0 the curve overshoots past both roads before
 * settling, which reads as a swerve; below about 0.5 it straightens into a dogleg with
 * visible corners at the feet. This is the fraction of the run each end pulls along its
 * own road before the curve is allowed to move across.
 */
export function sampleCrossover(from: Vec2, to: Vec2, count: number): EdgeSamples {
  const steps = Math.max(2, Math.floor(count));
  const run = to[0] - from[0];
  const tangent = Math.abs(run) * HERMITE_TENSION * Math.sign(run || 1);

  const poses: Pose[] = [];
  const cumulative: number[] = [];
  let travelled = 0;
  let previous: Vec2 = from;

  for (let index = 0; index <= steps; index++) {
    const t = index / steps;
    const point = hermite(from, to, tangent, t);
    if (index > 0) travelled += distance(previous, point);
    previous = point;
    poses.push({
      x: point[0],
      y: point[1],
      angle: hermiteHeading(from, to, tangent, t),
    });
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

const HERMITE_TENSION = 0.62;

/** Standard cubic Hermite with tangents `(tangent, 0)` at both ends. */
function hermite(from: Vec2, to: Vec2, tangent: number, t: number): Vec2 {
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return [
    h00 * from[0] + h10 * tangent + h01 * to[0] + h11 * tangent,
    // The y tangent is zero at both ends, which is the whole point: every edge leaves and
    // arrives running along its road, so junctions cannot disagree about a heading.
    h00 * from[1] + h01 * to[1],
  ];
}

/**
 * The tangent, analytically rather than by finite difference.
 *
 * A difference estimate is degenerate at both ends of the curve, which is precisely where
 * a train sits while it waits at a signal — the locomotive flipped through a right angle
 * on the frame it stopped.
 */
function hermiteHeading(from: Vec2, to: Vec2, tangent: number, t: number): number {
  const t2 = t * t;
  const d00 = 6 * t2 - 6 * t;
  const d10 = 3 * t2 - 4 * t + 1;
  const d01 = -6 * t2 + 6 * t;
  const d11 = 3 * t2 - 2 * t;
  const dx = d00 * from[0] + d10 * tangent + d01 * to[0] + d11 * tangent;
  const dy = d00 * from[1] + d01 * to[1];
  // Both derivatives vanish only on a zero-length crossover, which the scene forbids.
  if (dx === 0 && dy === 0) return Math.atan2(to[1] - from[1], to[0] - from[0]);
  return Math.atan2(dy, dx);
}

/**
 * The pose at an arc length along a sampled edge.
 *
 * **Extrapolated** past both ends along the terminal tangent, not clamped.
 *
 * Clamping was the single most visible defect in the first version and it caused three
 * separate ones. A locomotive running off the side of the scene pinned itself on the last
 * node while its distance kept climbing, so every wagon in turn slid onto that same point
 * and the whole rake concertinaed into a heap before vanishing. Entering, the reverse: a
 * six-wagon train materialised as one stack and unfolded. And a rake's rear wagon is
 * routinely at a negative distance while its locomotive is still leaving the shed — the
 * wagon is genuinely *behind* the first node, and clamping drew it on top of it.
 *
 * The rails are a mathematical line, not a fence. Past the end of one there is more of it.
 */
export function poseAtDistance(samples: EdgeSamples, at: number): Pose {
  const { poses, cumulative, length } = samples;

  if (at < 0) {
    const { x, y, angle } = samples.start;
    return { x: x + Math.cos(angle) * at, y: y + Math.sin(angle) * at, angle };
  }
  if (at > length) {
    const over = at - length;
    const { x, y, angle } = samples.end;
    return { x: x + Math.cos(angle) * over, y: y + Math.sin(angle) * over, angle };
  }

  /*
   * Binary search for the segment holding `at`. Linear was fine at the twenty-four
   * samples a crossover gets and is not at the count a wide viewport asks for, and this
   * runs once per vehicle per frame — roughly twenty times, times sixty.
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
  // Two coincident samples: possible where a crossover's ends are very close in x.
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
 * A plain lerp from 179 degrees to -179 sweeps 358 the wrong way, which on a train is a
 * full spin inside one frame.
 */
export function lerpAngle(a: number, b: number, t: number): number {
  const twoPi = Math.PI * 2;
  let delta = (b - a) % twoPi;
  if (delta > Math.PI) delta -= twoPi;
  if (delta < -Math.PI) delta += twoPi;
  return a + delta * t;
}

/**
 * Rotates a vehicle-local point onto the ground plane at a pose.
 *
 * Local +x is forward along the heading and local +y is to the left. This is the *only*
 * place a heading turns into a position, which is what makes it impossible for the
 * renderer and the simulation to disagree about where a chimney is — the previous version
 * had `drawVehicle` rotating the offset and the smoke emitter adding it to world y
 * unrotated, so puffs detached from the locomotive on every curve.
 */
export function localToWorld(pose: Pose, forward: number, left: number): Vec2 {
  const cos = Math.cos(pose.angle);
  const sin = Math.sin(pose.angle);
  return [pose.x + forward * cos - left * sin, pose.y + forward * sin + left * cos];
}
