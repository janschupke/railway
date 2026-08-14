import { describe, expect, it } from "vitest";
import catalog from "../../../messages/en.json";
import {
  DEPLOYMENT_STEPS,
  isDeploymentStep,
  isTerminal,
  isTransitioning,
  toContainerState,
} from "./types";

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
    // Settled, and it used to be in neither predicate: the monitor never emitted `done`,
    // the stream ran to the fifteen-minute ceiling and the browser redialled it forever.
    expect(isTerminal("sleeping")).toBe(true);
    expect(isTerminal("building")).toBe(false);
    // Deliberately in neither. It means Railway sent a status this app does not map, and
    // guessing "settled" would close a stream on the week they add one. The monitor
    // bounds it by poll count instead.
    expect(isTerminal("unknown")).toBe(false);
    expect(isTransitioning("unknown")).toBe(false);
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

describe("isDeploymentStep", () => {
  it("accepts every member Railway currently publishes", () => {
    for (const step of DEPLOYMENT_STEPS) expect(isDeploymentStep(step)).toBe(true);
  });

  it("degrades an unknown member instead of letting it reach the catalog", () => {
    /*
     * The narrowing exists so `t(`deploymentStep.${step}`)` cannot be handed a key the
     * catalog does not hold. Railway adds enum members without notice, and the cost of
     * getting this wrong is a missing-message marker rendered at the user.
     */
    expect(isDeploymentStep("SOME_FUTURE_STEP")).toBe(false);
    expect(isDeploymentStep("build_image")).toBe(false);
    expect(isDeploymentStep(null)).toBe(false);
    expect(isDeploymentStep(undefined)).toBe(false);
    expect(isDeploymentStep(7)).toBe(false);
  });

  it("has a catalog entry for every member", () => {
    // The other half of the two-edit rule: a member here needs copy in messages/en.json,
    // and nothing but this test compares the two.
    const labels: Record<string, string> = catalog.containers.deploymentStep;
    for (const step of DEPLOYMENT_STEPS) {
      expect(typeof labels[step], `containers.deploymentStep.${step} is missing`).toBe(
        "string",
      );
    }
  });

  it("carries no catalog entry for a step it does not know", () => {
    // The reverse direction, which is how a renamed member leaves dead copy behind.
    const labels: Record<string, string> = catalog.containers.deploymentStep;
    for (const key of Object.keys(labels)) expect(isDeploymentStep(key)).toBe(true);
  });
});
