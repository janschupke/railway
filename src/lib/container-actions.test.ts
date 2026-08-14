import { describe, expect, it } from "vitest";
import { availableActions } from "./container-actions";
import { CONTAINER_STATES, type ContainerState } from "@/lib/railway/types";

const container = (state: ContainerState, deploymentId: string | null = "dep_1") => ({
  state,
  deploymentId,
});

describe("availableActions", () => {
  it("offers stop and restart to a running container", () => {
    expect(availableActions(container("running"))).toEqual(["stop", "restart"]);
  });

  it.each(["pending", "building", "deploying"] as const)(
    "offers only stop while %s",
    (state) => {
      // There is no container yet, so there is nothing to restart — and Railway would
      // refuse a restart of a deployment that has not finished deploying.
      expect(availableActions(container(state))).toEqual(["stop"]);
    },
  );

  it.each(["failed", "sleeping", "removed", "unknown"] as const)(
    "offers redeploy once settled at %s",
    (state) => {
      expect(availableActions(container(state))).toEqual(["redeploy"]);
    },
  );

  it("offers redeploy to a service whose first deploy was refused", () => {
    /*
     * The orphan `createContainer` leaves behind: a service exists and is billable, and it
     * has no deployment at all. It is the row this control matters most on, and it is also
     * why redeploy goes through `serviceInstanceDeployV2` rather than `deploymentRedeploy`
     * — there is no deployment id here to redeploy.
     */
    expect(availableActions({ state: "unknown", deploymentId: null })).toEqual([
      "redeploy",
    ]);
  });

  it("offers nothing while the container is being removed", () => {
    // The row still renders Destroy, disabled, which is the affordance this state has.
    expect(availableActions(container("removing"))).toEqual([]);
  });

  it("never offers both stop and redeploy", () => {
    /*
     * The property the row's layout depends on: at most three controls at once, so the
     * action slot cannot grow past what the row can hold. Asserted over every state rather
     * than the ones listed above, so a state added to CONTAINER_STATES has to answer for
     * itself here.
     */
    for (const state of CONTAINER_STATES) {
      for (const deploymentId of ["dep_1", null]) {
        const actions = availableActions(container(state, deploymentId));
        expect(actions.includes("stop") && actions.includes("redeploy")).toBe(false);
        expect(actions.length).toBeLessThanOrEqual(2);
      }
    }
  });
});
