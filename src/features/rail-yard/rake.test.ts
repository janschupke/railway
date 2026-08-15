import { describe, expect, it } from "vitest";

import { LOCOMOTIVE, WAGON, YARD } from "./config";
import { rakeLength, wagonNoseDistance } from "./rake";

describe("wagonNoseDistance", () => {
  it("counts back from the locomotive, wagon by wagon", () => {
    const first = wagonNoseDistance(1000, 0);
    const second = wagonNoseDistance(1000, 1);
    expect(first).toBeLessThan(1000);
    expect(second).toBeLessThan(first);
    // Even spacing, which is what lets the crane serve wagon k without asking the renderer.
    expect(first - second).toBeCloseTo(
      wagonNoseDistance(1000, 1) - wagonNoseDistance(1000, 2),
    );
  });

  it("leaves a coupling between the locomotive and the first wagon", () => {
    // The gap is in front of wagon 0, not behind it — getting that backwards buries the
    // first wagon in the locomotive, which is the direction this arithmetic fails in.
    expect(wagonNoseDistance(1000, 0)).toBe(1000 - LOCOMOTIVE.length - YARD.WAGON_GAP);
  });
});

describe("rakeLength", () => {
  it("is the locomotive alone when nothing is coupled to it", () => {
    expect(rakeLength(0)).toBe(LOCOMOTIVE.length);
  });

  it("grows by one wagon and one coupling per wagon", () => {
    const pitch = WAGON.length + YARD.WAGON_GAP;
    expect(rakeLength(2) - rakeLength(1)).toBeCloseTo(pitch);
    expect(rakeLength(3) - rakeLength(2)).toBeCloseTo(pitch);
  });

  it("reaches past the last wagon the crane can be sent to", () => {
    /*
     * The two halves of this module have to agree, and nothing else checks that they do:
     * the length is what traffic reserves, and `wagonNoseDistance` is where the crane
     * aims. A rake that the crane can reach beyond is one that fouls the junction behind
     * it while reporting itself clear.
     */
    const wagons = 4;
    const tail = wagonNoseDistance(1000, wagons - 1) - WAGON.length;
    expect(1000 - tail).toBeLessThanOrEqual(rakeLength(wagons));
  });
});
