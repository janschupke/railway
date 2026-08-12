import { describe, expect, it } from "vitest";
import { isTerminal, isTransitioning, toContainerState } from "./types";

describe("toContainerState", () => {
  it("maps Railway's success status to running", () => {
    expect(toContainerState("SUCCESS")).toBe("running");
  });

  it("treats CRASHED and FAILED as the same user-visible failure", () => {
    expect(toContainerState("CRASHED")).toBe("failed");
    expect(toContainerState("FAILED")).toBe("failed");
  });

  it("collapses the several pre-build statuses into pending", () => {
    for (const status of ["QUEUED", "WAITING", "INITIALIZING", "NEEDS_APPROVAL"]) {
      expect(toContainerState(status)).toBe("pending");
    }
  });

  it("is case-insensitive", () => {
    expect(toContainerState("building")).toBe("building");
  });

  it("degrades unknown statuses instead of throwing", () => {
    // Railway can add enum members at any time; a new one must not blank the UI.
    expect(toContainerState("SOME_FUTURE_STATUS")).toBe("unknown");
    expect(toContainerState(null)).toBe("unknown");
    expect(toContainerState(undefined)).toBe("unknown");
  });
});

describe("state predicates", () => {
  it("closes the stream only on settled states", () => {
    expect(isTerminal("running")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("removed")).toBe(true);
    expect(isTerminal("building")).toBe(false);
    expect(isTerminal("unknown")).toBe(false);
  });

  it("keeps the stream open while work is in flight", () => {
    expect(isTransitioning("building")).toBe(true);
    expect(isTransitioning("deploying")).toBe(true);
    expect(isTransitioning("removing")).toBe(true);
    expect(isTransitioning("running")).toBe(false);
  });

  it("never reports a state as both terminal and transitioning", () => {
    const states = [
      "pending",
      "building",
      "deploying",
      "running",
      "failed",
      "sleeping",
      "removing",
      "removed",
      "unknown",
    ] as const;
    for (const state of states) {
      expect(isTerminal(state) && isTransitioning(state)).toBe(false);
    }
  });
});
