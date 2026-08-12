import { describe, expect, it } from "vitest";
import { acquireStreamSlot, activeStreamCount } from "./stream-slots";

/**
 * The counter's arithmetic. That it is actually decremented on every teardown path is
 * proved separately, by the `onClose` cases in sse.test.ts — the two together are what
 * make "a stream cannot leak a slot" a checked statement rather than a hope.
 */
describe("acquireStreamSlot", () => {
  it("hands out slots up to the limit and then refuses", () => {
    const releases = [acquireStreamSlot("u1", 2), acquireStreamSlot("u1", 2)] as Array<
      () => void
    >;

    expect(releases.every(Boolean)).toBe(true);
    expect(acquireStreamSlot("u1", 2)).toBeNull();
    expect(activeStreamCount("u1")).toBe(2);

    releases[0]!();
    expect(acquireStreamSlot("u1", 2)).not.toBeNull();
  });

  it("ignores a repeated release, so a doubled teardown cannot mint a slot", () => {
    // sse.ts already guards close(), but a counter that trusts its caller is a counter
    // that eventually goes negative.
    const release = acquireStreamSlot("u2", 1)!;
    release();
    release();
    release();

    expect(activeStreamCount("u2")).toBe(0);
    expect(acquireStreamSlot("u2", 1)).not.toBeNull();
  });

  it("budgets each user separately", () => {
    acquireStreamSlot("u3", 1);
    expect(acquireStreamSlot("u3", 1)).toBeNull();
    expect(acquireStreamSlot("u4", 1)).not.toBeNull();
  });

  it("leaves no residue for a user who has gone", () => {
    const release = acquireStreamSlot("u5", 4)!;
    release();
    expect(activeStreamCount("u5")).toBe(0);
  });
});
