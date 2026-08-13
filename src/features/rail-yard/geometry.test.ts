import { describe, expect, it } from "vitest";
import {
  clamp,
  lerp,
  lerpAngle,
  poseAtDistance,
  sampleEdge,
  type Vec2,
} from "./geometry";

const A: Vec2 = [0, 0];
const B: Vec2 = [100, 0];
const VIA: Vec2 = [50, 60];

describe("lerp and clamp", () => {
  it("interpolates and clamps at both ends", () => {
    expect(lerp(0, 10, 0.25)).toBe(2.5);
    expect(clamp(-1, 0, 5)).toBe(0);
    expect(clamp(9, 0, 5)).toBe(5);
    expect(clamp(3, 0, 5)).toBe(3);
  });
});

describe("sampleEdge", () => {
  it("spends two samples on a straight and no more", () => {
    // The search in poseAtDistance is exact for a line; twenty-four entries describing
    // one would sit in every frame's working set for nothing.
    const samples = sampleEdge(A, B, null, 24);
    expect(samples.poses).toHaveLength(2);
    expect(samples.length).toBeCloseTo(100);
  });

  it("puts its endpoints exactly on the nodes", () => {
    for (const via of [null, VIA]) {
      const samples = sampleEdge(A, B, via, 24);
      expect([samples.start.x, samples.start.y]).toEqual([0, 0]);
      expect([samples.end.x, samples.end.y]).toEqual([100, 0]);
    }
  });

  it("measures a curve as longer than its chord and shorter than its control polygon", () => {
    const samples = sampleEdge(A, B, VIA, 24);
    const chord = 100;
    const polygon = Math.hypot(50, 60) * 2;
    expect(samples.length).toBeGreaterThan(chord);
    expect(samples.length).toBeLessThan(polygon);
  });

  it("converges as the sample count rises", () => {
    const coarse = sampleEdge(A, B, VIA, 4).length;
    const fine = sampleEdge(A, B, VIA, 256).length;
    expect(fine).toBeGreaterThanOrEqual(coarse);
    expect(fine - coarse).toBeLessThan(1);
  });

  it("produces a strictly increasing arc-length table", () => {
    const { cumulative } = sampleEdge(A, B, VIA, 24);
    expect(cumulative[0]).toBe(0);
    for (let index = 1; index < cumulative.length; index++) {
      expect(cumulative[index]!).toBeGreaterThan(cumulative[index - 1]!);
    }
  });

  it("tolerates a degenerate sample count", () => {
    expect(sampleEdge(A, B, VIA, 0).poses.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps a heading when the control point sits on the chord's midpoint", () => {
    // Both derivative terms vanish at t = 0.5 there, and atan2(0, 0) is not a heading.
    const samples = sampleEdge(A, B, [50, 0], 4);
    for (const pose of samples.poses) expect(Number.isFinite(pose.angle)).toBe(true);
  });
});

describe("poseAtDistance", () => {
  const straight = sampleEdge(A, B, null, 24);
  const curve = sampleEdge(A, B, VIA, 24);

  it("clamps rather than extrapolating at both ends", () => {
    // A rake's rear wagon is routinely at a negative distance while its locomotive is
    // still leaving the depot. It should sit on the rails, not float off them.
    expect(poseAtDistance(straight, -500)).toEqual(straight.start);
    expect(poseAtDistance(straight, 5_000)).toEqual(straight.end);
  });

  it("advances uniformly along a straight", () => {
    expect(poseAtDistance(straight, 25).x).toBeCloseTo(25);
    expect(poseAtDistance(straight, 75).x).toBeCloseTo(75);
  });

  it("advances by arc length, not by Bezier parameter, along a curve", () => {
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
    const smallest = Math.min(...gaps);
    const largest = Math.max(...gaps);
    expect(largest / smallest).toBeLessThan(1.05);
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
    // full spin inside one frame. Only the depot's reversing curve crosses it.
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
