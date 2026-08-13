import { describe, expect, it } from "vitest";
import {
  clamp,
  lerp,
  lerpAngle,
  localToWorld,
  poseAtDistance,
  sampleCrossover,
  sampleRun,
  type Vec2,
} from "./geometry";

const A: Vec2 = [0, 0];
const B: Vec2 = [100, 0];
/** A crossover: 300 along the road, 46 across it. The scene's adjacent-road figure. */
const C: Vec2 = [300, 46];

describe("lerp and clamp", () => {
  it("interpolates and clamps at both ends", () => {
    expect(lerp(0, 10, 0.25)).toBe(2.5);
    expect(clamp(-1, 0, 5)).toBe(0);
    expect(clamp(9, 0, 5)).toBe(5);
    expect(clamp(3, 0, 5)).toBe(3);
  });
});

describe("sampleRun", () => {
  it("spends two samples on a straight and no more", () => {
    // The search in poseAtDistance is exact for a line; twenty-four entries describing
    // one would sit in every frame's working set for nothing.
    const samples = sampleRun(A, B);
    expect(samples.poses).toHaveLength(2);
    expect(samples.length).toBeCloseTo(100);
  });

  it("puts its endpoints exactly on the nodes and holds one heading throughout", () => {
    const samples = sampleRun(A, B);
    expect([samples.start.x, samples.start.y]).toEqual([0, 0]);
    expect([samples.end.x, samples.end.y]).toEqual([100, 0]);
    expect(samples.start.angle).toBe(0);
    expect(samples.end.angle).toBe(0);
  });
});

describe("sampleCrossover", () => {
  it("puts its endpoints exactly on the nodes", () => {
    const samples = sampleCrossover(A, C, 24);
    expect([samples.start.x, samples.start.y]).toEqual([0, 0]);
    expect(samples.end.x).toBeCloseTo(300);
    expect(samples.end.y).toBeCloseTo(46);
  });

  it("leaves and arrives running along the road", () => {
    /*
     * The claim the whole scene rests on. Every node sits on a horizontal road, so if
     * every edge is horizontal at both ends then two edges meeting at a node cannot
     * disagree about a heading — and the 128.7 degree snap the hand-authored quadratics
     * left at one junction becomes unexpressible rather than fixed.
     */
    for (const [from, to] of [
      [A, C],
      [C, A],
      [
        [0, 46],
        [420, 0],
      ],
    ] as const) {
      const samples = sampleCrossover(from, to, 24);
      expect(Math.abs(Math.sin(samples.start.angle))).toBeLessThan(1e-12);
      expect(Math.abs(Math.sin(samples.end.angle))).toBeLessThan(1e-12);
    }
  });

  it("advances monotonically along the road rather than doubling back", () => {
    // A hairpin would be geometrically valid and is not a turnout. The tension constant
    // is what keeps it out, and this is the assertion that pins the constant.
    const { poses } = sampleCrossover(A, C, 24);
    for (let index = 1; index < poses.length; index++) {
      expect(poses[index]!.x).toBeGreaterThan(poses[index - 1]!.x);
    }
  });

  it("keeps the blade angle inside a real turnout ratio", () => {
    /*
     * The steepest point of a 300-by-46 crossover is its middle. A prototype turnout is
     * quoted as a ratio of run to spread; anything past about 1-in-5 stops looking like
     * track and starts looking like a road junction.
     */
    const { poses } = sampleCrossover(A, C, 48);
    const steepest = Math.max(...poses.map((pose) => Math.abs(Math.tan(pose.angle))));
    expect(steepest).toBeGreaterThan(0);
    expect(1 / steepest).toBeGreaterThan(5);
  });

  it("measures longer than its chord", () => {
    const samples = sampleCrossover(A, C, 24);
    expect(samples.length).toBeGreaterThan(Math.hypot(300, 46));
  });

  it("converges as the sample count rises", () => {
    const coarse = sampleCrossover(A, C, 4).length;
    const fine = sampleCrossover(A, C, 256).length;
    expect(fine).toBeGreaterThanOrEqual(coarse);
    expect(fine - coarse).toBeLessThan(1);
  });

  it("produces a strictly increasing arc-length table", () => {
    const { cumulative } = sampleCrossover(A, C, 24);
    expect(cumulative[0]).toBe(0);
    for (let index = 1; index < cumulative.length; index++) {
      expect(cumulative[index]!).toBeGreaterThan(cumulative[index - 1]!);
    }
  });

  it("tolerates a degenerate sample count", () => {
    expect(sampleCrossover(A, C, 0).poses.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps a heading on a crossover with no run at all", () => {
    // Both derivatives vanish there, and atan2(0, 0) is not a heading. The scene forbids
    // it, but a scene is data and this is the one place that costs nothing to survive.
    const samples = sampleCrossover(A, [0, 46], 4);
    for (const pose of samples.poses) expect(Number.isFinite(pose.angle)).toBe(true);
  });
});

describe("poseAtDistance", () => {
  const straight = sampleRun(A, B);
  const curve = sampleCrossover(A, C, 24);

  it("extrapolates along the terminal tangent rather than clamping", () => {
    /*
     * Clamping caused three separate visible defects: a departing train concertinaed onto
     * the last node before vanishing, an arriving one materialised as a single stack and
     * unfolded, and a rake's rear wagon sat on top of the first node instead of behind it
     * while the locomotive was still leaving the shed. Past the end of a rail there is
     * more rail.
     */
    expect(poseAtDistance(straight, -500).x).toBeCloseTo(-500);
    expect(poseAtDistance(straight, -500).angle).toBeCloseTo(straight.start.angle);
    expect(poseAtDistance(straight, 5_000).x).toBeCloseTo(5_000);
    expect(poseAtDistance(straight, 5_000).angle).toBeCloseTo(straight.end.angle);
  });

  it("extrapolates a crossover along the road it arrived on, not across it", () => {
    // The terminal tangent is horizontal, so an overrun runs on down the road. If it
    // extrapolated along the chord instead, a train would drift between roads.
    const over = poseAtDistance(curve, curve.length + 200);
    expect(over.y).toBeCloseTo(46);
    expect(over.x).toBeCloseTo(500);
  });

  it("advances uniformly along a straight", () => {
    expect(poseAtDistance(straight, 25).x).toBeCloseTo(25);
    expect(poseAtDistance(straight, 75).x).toBeCloseTo(75);
  });

  it("advances by arc length, not by curve parameter", () => {
    /*
     * The bug this catches: advancing `t` linearly makes a locomotive slow through the
     * middle of a turn and shoot out of the end. Equal distance steps must cover roughly
     * equal ground.
     */
    const step = curve.length / 8;
    const gaps: number[] = [];
    for (let index = 0; index < 8; index++) {
      const from = poseAtDistance(curve, index * step);
      const to = poseAtDistance(curve, (index + 1) * step);
      gaps.push(Math.hypot(to.x - from.x, to.y - from.y));
    }
    expect(Math.max(...gaps) / Math.min(...gaps)).toBeLessThan(1.05);
  });

  it("stays finite everywhere along a curve", () => {
    for (let at = 0; at <= curve.length; at += curve.length / 40) {
      const pose = poseAtDistance(curve, at);
      expect(Number.isFinite(pose.x) && Number.isFinite(pose.y)).toBe(true);
      expect(Number.isFinite(pose.angle)).toBe(true);
    }
  });
});

describe("lerpAngle", () => {
  it("takes the short way round the discontinuity", () => {
    // A plain lerp from 179 degrees to -179 sweeps the other 358, which on a train is a
    // full spin inside one frame.
    const from = Math.PI - 0.01;
    const to = -Math.PI + 0.01;
    const middle = lerpAngle(from, to, 0.5);
    expect(Math.abs(Math.abs(middle) - Math.PI)).toBeLessThan(0.02);
  });

  it("is the identity at both ends", () => {
    expect(lerpAngle(0.3, 1.2, 0)).toBeCloseTo(0.3);
    expect(lerpAngle(0.3, 1.2, 1)).toBeCloseTo(1.2);
  });

  it("interpolates normally away from the discontinuity", () => {
    expect(lerpAngle(0, 1, 0.5)).toBeCloseTo(0.5);
  });
});

describe("localToWorld", () => {
  it("puts local +x forward and local +y to the left", () => {
    const east = { x: 10, y: 20, angle: 0 };
    expect(localToWorld(east, 5, 0)).toEqual([15, 20]);
    expect(localToWorld(east, 0, 5)).toEqual([10, 25]);
  });

  it("carries the offset round with the heading", () => {
    // The failure this exists to stop: the renderer rotating a chimney offset while the
    // smoke emitter added it to world y unrotated, so puffs detached on every curve.
    const north = { x: 0, y: 0, angle: Math.PI / 2 };
    const [x, y] = localToWorld(north, 10, 0);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(10);
  });
});
