import { describe, expect, it } from "vitest";
import { GANTRY_STRUCTURE, at } from "@/test/rail-yard";
import { CONVEYOR, CRANE } from "./config";
import { CONTAINER, GANTRY, TRACK, WAGON } from "./sprites";
import { RAIL_YARD_SCENE } from "./scene";
import type { SceneStructure } from "./scene-types";
import { assemblyDepth } from "./drawable";

/*
 * The painter's sort key, tested directly.
 *
 * It moved here with `assemblyDepth` itself, out of `render.test.ts` — a sort checked
 * through a rendered frame is checked by accident, because the recording says what was
 * painted and not which of two things the painter believed was nearer.
 */

describe("assemblyDepth", () => {
  /*
   * The painter's sort key, and the whole of five reported defects. Every one of them was a
   * pair of solids that overlap on screen being ordered by a rule that could not tell them
   * apart, so this is asserted on pairs rather than on numbers.
   */
  const PORTAL_X = GANTRY_STRUCTURE.travel[0];
  const beltY = (
    RAIL_YARD_SCENE.structures.find((one) => one.kind === "conveyor") as Extract<
      SceneStructure,
      { kind: "conveyor" }
    >
  ).at[1];

  it("puts the higher of two boxes standing in one place in front", () => {
    /*
     * "The crane magnet has a z-index problem". The spreader and the container in its jaws
     * share a portal x and a trolley y, so a key that reads depth alone called them equal
     * and insertion order decided — which painted the container's lit top face over the
     * spreader holding it.
     */
    const pose = at(PORTAL_X, beltY);
    const carried = {
      at: [-CONTAINER.size[0] / 2, -CONTAINER.size[1] / 2, CRANE.TRAVEL_Z],
      size: CONTAINER.size,
      fill: "cargo",
    } as const;
    const spreader = {
      at: [
        -GANTRY.spreaderLength / 2,
        -GANTRY.spreaderDepth / 2,
        CRANE.TRAVEL_Z + CONTAINER.size[2],
      ],
      size: [GANTRY.spreaderLength, GANTRY.spreaderDepth, GANTRY.spreaderHeight],
      fill: "metal",
    } as const;

    expect(assemblyDepth(pose, [spreader])).toBeLessThan(
      assemblyDepth(pose, [carried]),
    );
  });

  it("takes a whole vehicle at once, parts and all", () => {
    /*
     * The unit is the assembly, not the box, and this is why. A wagon's frame runs its whole
     * length while its front bogie sits under the east end of it, so the bogie's own centre
     * is nearer the camera than the frame's — sorted apart, the bogie was painted on top of
     * the frame as a grey square. Together they are one solid at one distance.
     */
    const pose = at(1280, TRACK.ROAD_PITCH * 2);
    const frame = WAGON.boxes.find((box) => box.size[0] === WAGON.length)!;
    const bogie = WAGON.boxes[1]!;
    expect(assemblyDepth(pose, [bogie], WAGON.length)).toBeLessThan(
      assemblyDepth(pose, [frame], WAGON.length),
    );
    // The whole wagon is one key, and it lies between the parts that made it up.
    const whole = assemblyDepth(pose, WAGON.boxes, WAGON.length);
    expect(whole).toBeLessThan(assemblyDepth(pose, [WAGON.boxes[0]!], WAGON.length));
    expect(whole).toBeGreaterThan(assemblyDepth(pose, [bogie], WAGON.length));
  });

  it("a canopy wins against the whole of what it spans", () => {
    /*
     * The gantry beam against the leg holding up its near end. Both are keyed at the portal's
     * own x, so depth is all that separates them — and the beam's centre is half the portal's
     * span behind the leg, which is why a centre key painted the leg's lit top face across
     * two thirds of the beam's near end.
     */
    const span = GANTRY_STRUCTURE.far - GANTRY_STRUCTURE.near;
    const beam = {
      at: [-GANTRY.beamWidth / 2, -span - GANTRY.legDepth / 2, GANTRY.height],
      size: [GANTRY.beamWidth, span + GANTRY.legDepth, GANTRY.beamHeight],
      fill: "structureTrim",
    } as const;
    const leg = {
      at: [-GANTRY.legWidth / 2, -GANTRY.legDepth / 2, 0],
      size: [GANTRY.legWidth, GANTRY.legDepth, GANTRY.height],
      fill: "structureTrim",
    } as const;

    const beamPose = at(PORTAL_X, GANTRY_STRUCTURE.far);
    const legPose = at(PORTAL_X, GANTRY_STRUCTURE.near);
    expect(assemblyDepth(beamPose, [beam], 0, "over")).toBeLessThan(
      assemblyDepth(legPose, [leg]),
    );
    // And without the flag it loses, which is the defect this replaced.
    expect(assemblyDepth(beamPose, [beam])).toBeGreaterThan(
      assemblyDepth(legPose, [leg]),
    );
  });

  it("a floor loses against everything standing on it", () => {
    /*
     * The belt deck against a container the crane is lowering onto its head slot. The deck
     * runs most of a thousand units east of the head, so its centre sits well in front of the
     * box — it was painted over the container, which reappeared the moment it was released
     * and became belt freight drawn later. That was the flicker.
     */
    const head = at(1230, beltY);
    const deck = {
      at: [-CONVEYOR.PITCH / 2, -CONVEYOR.WIDTH / 2, 0],
      size: [670 + CONVEYOR.PITCH, CONVEYOR.WIDTH, CONVEYOR.DECK_Z],
      fill: "structureTrim",
    } as const;
    const freight = {
      at: [-CONTAINER.size[0] / 2, -CONTAINER.size[1] / 2, CONVEYOR.DECK_Z],
      size: CONTAINER.size,
      fill: "cargo",
    } as const;

    expect(assemblyDepth(head, [deck], 0, "under")).toBeGreaterThan(
      assemblyDepth(head, [freight]),
    );
    expect(assemblyDepth(head, [deck])).toBeLessThan(assemblyDepth(head, [freight]));
  });
});
