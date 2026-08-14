import { describe, expect, it } from "vitest";
import { pickFailureReason, type DeploymentEventNode } from "./failure-reason";

const MAX = 300;

/**
 * Characters this module exists to remove, built from code points rather than typed in.
 *
 * A literal U+2028 or U+0007 is invisible in an editor and makes the source file read as
 * binary to `grep` and to a diff viewer. Naming them costs three lines and means the one
 * place they appear says which they are.
 */
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const NEXT_LINE = String.fromCodePoint(0x85);
const BELL = String.fromCodePoint(0x07);

/** The shape `deploymentEvents` returns, with only the members under test filled in. */
const event = (
  step: string | null,
  payload: DeploymentEventNode["payload"] = null,
): DeploymentEventNode => ({ step, payload });

describe("pickFailureReason", () => {
  it("takes the reason from the newest event that carries one", () => {
    // Relay's `last:` returns the tail oldest-first, so the newest event is the last edge.
    const picked = pickFailureReason(
      [
        event("SNAPSHOT_CODE", { error: "an older failure nobody is looking at" }),
        event("BUILD_IMAGE", { error: "manifest for redis:nope not found" }),
      ],
      MAX,
    );

    expect(picked).toEqual({
      step: "BUILD_IMAGE",
      reason: "manifest for redis:nope not found",
    });
  });

  it("prefers error, then reason, then detail, within one event", () => {
    const all = { error: "from error", reason: "from reason", detail: "from detail" };

    expect(pickFailureReason([event("BUILD_IMAGE", all)], MAX)?.reason).toBe(
      "from error",
    );
    expect(
      pickFailureReason([event("BUILD_IMAGE", { ...all, error: null })], MAX)?.reason,
    ).toBe("from reason");
    expect(
      pickFailureReason(
        [event("BUILD_IMAGE", { ...all, error: null, reason: null })],
        MAX,
      )?.reason,
    ).toBe("from detail");
  });

  it("takes step and reason from the same event, never a mix", () => {
    /*
     * The failure this pins: pairing the newest event's step with an older event's text
     * reads as "the health check step failed: manifest not found", which is a confident
     * lie about which part broke.
     */
    const picked = pickFailureReason(
      [event("BUILD_IMAGE", { error: "manifest not found" }), event("HEALTHCHECK", {})],
      MAX,
    );

    expect(picked).toEqual({ step: "BUILD_IMAGE", reason: "manifest not found" });
  });

  it("passes over skipped steps", () => {
    const picked = pickFailureReason(
      [
        event("BUILD_IMAGE", { error: "the real failure" }),
        event("PRE_DEPLOY_COMMAND", { skipped: true, error: "not run" }),
      ],
      MAX,
    );

    expect(picked).toEqual({ step: "BUILD_IMAGE", reason: "the real failure" });
  });

  it("falls back to the newest step when no event carries text", () => {
    const picked = pickFailureReason(
      [event("BUILD_IMAGE", {}), event("HEALTHCHECK", {})],
      MAX,
    );

    expect(picked).toEqual({ step: "HEALTHCHECK", reason: null });
  });

  it("returns null when there is nothing to say", () => {
    // The row keeps the sentence it already had rather than gaining an empty one.
    expect(pickFailureReason([], MAX)).toBeNull();
    expect(pickFailureReason([event(null, {})], MAX)).toBeNull();
    expect(
      pickFailureReason([event("BUILD_IMAGE", { skipped: true, error: "x" })], MAX),
    ).toBeNull();
  });

  it("tolerates a null payload and a missing step", () => {
    // Both are nullable in Railway's schema, so both arrive eventually.
    expect(pickFailureReason([event("BUILD_IMAGE", null)], MAX)).toEqual({
      step: "BUILD_IMAGE",
      reason: null,
    });
    expect(pickFailureReason([{ payload: { error: "no step here" } }], MAX)).toEqual({
      step: null,
      reason: "no step here",
    });
  });

  it("ignores members that are not strings", () => {
    expect(
      pickFailureReason([event("BUILD_IMAGE", { error: 42 as never })], MAX),
    ).toEqual({ step: "BUILD_IMAGE", reason: null });
  });

  describe("bounding", () => {
    it("keeps the first non-empty line and drops the rest", () => {
      const picked = pickFailureReason(
        [
          event("HEALTHCHECK", {
            error: "\n\nservice unavailable\n  at handler (app.js:12)\n  at next",
          }),
        ],
        MAX,
      );

      expect(picked?.reason).toBe("service unavailable");
    });

    it("splits on the line separators a regex for \\n would miss", () => {
      const picked = pickFailureReason(
        [
          event("BUILD_IMAGE", {
            error: `pull refused${LINE_SEPARATOR}second line${NEXT_LINE}third line`,
          }),
        ],
        MAX,
      );

      expect(picked?.reason).toBe("pull refused");
    });

    it("replaces control characters with a space rather than deleting them", () => {
      // Deleting them silently welds two words together, corrupting the one string the
      // reader is being asked to act on.
      const picked = pickFailureReason(
        [event("BUILD_IMAGE", { error: `exit${BELL}code${BELL}1` })],
        MAX,
      );

      expect(picked?.reason).toBe("exit code 1");
    });

    it("collapses whitespace runs", () => {
      const picked = pickFailureReason(
        [event("BUILD_IMAGE", { error: "  image      not   found  " })],
        MAX,
      );

      expect(picked?.reason).toBe("image not found");
    });

    it("treats a whitespace-only value as no value at all", () => {
      expect(
        pickFailureReason([event("BUILD_IMAGE", { error: "   \n  \t " })], MAX),
      ).toEqual({ step: "BUILD_IMAGE", reason: null });
    });

    it("cuts an over-long reason on a word boundary and marks the cut", () => {
      const words = `${"alpha ".repeat(40)}omega`;
      const picked = pickFailureReason([event("BUILD_IMAGE", { error: words })], 50);

      expect(picked?.reason).toMatch(/…$/);
      expect(picked?.reason?.length).toBeLessThanOrEqual(51);
      // Cut back to a boundary, so the last word is whole rather than severed.
      expect(picked?.reason).not.toMatch(/alph…$/);
    });

    it("does not cut back to a boundary that would throw away the budget", () => {
      // One long token — a URL, a digest — has no useful boundary to fall back to.
      const picked = pickFailureReason(
        [event("BUILD_IMAGE", { error: `sha256:${"a".repeat(80)}` })],
        20,
      );

      expect(picked?.reason).toBe(`sha256:${"a".repeat(13)}…`);
    });

    it("leaves a reason at exactly the cap alone", () => {
      const exact = "a".repeat(20);
      expect(
        pickFailureReason([event("BUILD_IMAGE", { error: exact })], 20)?.reason,
      ).toBe(exact);
    });
  });
});
