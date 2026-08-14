import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ActionResult } from "@/lib/action-result";
import type { ContainerState } from "@/lib/railway/types";

/*
 * The three Server Actions and `spinDown`, stubbed together: this component's job is
 * choosing which controls exist, and importing the real module would drag the whole
 * server-side action graph into a jsdom render.
 */
const noop = async (): Promise<ActionResult> => ({ ok: true, message: "" });
vi.mock("@/app/dashboard/actions", () => ({
  spinDown: noop,
  stopContainer: noop,
  restartContainer: noop,
  redeployContainer: noop,
  editContainer: noop,
}));

const { ContainerActions } = await import("./container-actions");
const { ToastProvider } = await import("./ui/toast");

function renderActions(state: ContainerState, deploymentId: string | null = "dep_1") {
  return render(
    <ToastProvider>
      <ContainerActions
        serviceId="svc_1"
        displayName="cache"
        image="redis:7-alpine"
        deploymentId={deploymentId}
        state={state}
        projectId="p1"
        environmentId="e1"
      />
    </ToastProvider>,
  );
}

/** Every control the row is offering, by its visible label. */
const controls = () =>
  screen.getAllByRole("button").map((button) => button.textContent?.trim());

describe("ContainerActions", () => {
  it("offers stop and restart beside destroy while running", () => {
    renderActions("running");
    expect(controls()).toEqual(["Edit", "Stop", "Restart", "Destroy"]);
  });

  it("offers only stop while the deployment is still building", () => {
    // Nothing is running yet, so there is nothing to restart.
    renderActions("building");
    expect(controls()).toEqual(["Edit", "Stop", "Destroy"]);
  });

  it("offers redeploy once the container has stopped", () => {
    renderActions("removed");
    expect(controls()).toEqual(["Edit", "Redeploy", "Destroy"]);
  });

  it("offers redeploy to a service whose deploy was refused", () => {
    // The orphan with no deployment at all: before this feature its row held Destroy and
    // nothing else, which made a billable mistake a delete-and-retype.
    renderActions("unknown", null);
    expect(controls()).toEqual(["Edit", "Redeploy", "Destroy"]);
  });

  it("offers edit in every state a lifecycle verb is absent from", () => {
    /*
     * Editing is not in `availableActions` and this is why: that list answers "would this
     * mutation do anything to the running deployment", and every state has a description to
     * change — including the one with no deployment at all, where an unrunnable image is
     * exactly what a person needs to fix.
     */
    renderActions("unknown", null);
    expect(screen.getByRole("button", { name: /^edit$/i })).toBeEnabled();
  });

  it("disables both remaining controls while the container is being removed", () => {
    /*
     * Edit is dimmed here rather than absent, which is the one place it departs from the
     * lifecycle verbs' rule. The reason they are gated is that a control must not promise
     * something another state would deliver; `removing` is not another state, it is the
     * description going away, and the same argument that keeps Destroy on screen disabled
     * keeps this one.
     */
    renderActions("removing");
    expect(controls()).toEqual(["Edit", "Destroy"]);
    expect(screen.getByRole("button", { name: /destroy/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^edit$/i })).toBeDisabled();
  });

  it("never renders a disabled lifecycle control", () => {
    /*
     * State-gated rather than rendered-and-disabled, deliberately. A disabled control is a
     * promise that something would happen in another state, and "Restart" on a container
     * that is still building is not a promise this app can keep — so the control is absent
     * rather than dimmed.
     */
    renderActions("failed");
    expect(screen.getByRole("button", { name: /redeploy/i })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /^stop$/i })).not.toBeInTheDocument();
  });
});
