import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ActionResult } from "@/lib/action-result";
import type { Container, ContainerState } from "@/lib/railway/types";

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
// The detail dialog's trigger and the variable editor's rows are both tooltipped; the
// dashboard layout supplies this in the app, and a bare Tooltip is a Radix error.
const { TooltipProvider } = await import("./ui/tooltip");

const container = (deploymentId: string | null): Container => ({
  serviceId: "svc_1",
  rawName: "spun-cache",
  displayName: "cache",
  image: "redis:7-alpine",
  repo: null,
  state: "running",
  rawStatus: "SUCCESS",
  deploymentId,
  createdAt: null,
  updatedAt: null,
  deployedAt: null,
  url: null,
  managed: true,
});

function renderActions(state: ContainerState, deploymentId: string | null = "dep_1") {
  return render(
    <TooltipProvider>
      <ToastProvider>
        <ContainerActions
          container={container(deploymentId)}
          metrics={undefined}
          volume={undefined}
          state={state}
          projectId="p1"
          environmentId="e1"
        />
      </ToastProvider>
    </TooltipProvider>,
  );
}

/** Every control the row is offering, by its visible label. */
const controls = () =>
  screen.getAllByRole("button").map((button) => button.textContent?.trim());

describe("ContainerActions", () => {
  it("offers stop and restart beside destroy while running", () => {
    renderActions("running");
    expect(controls()).toEqual(["Details", "Stop", "Restart", "Destroy"]);
  });

  it("offers only stop while the deployment is still building", () => {
    // Nothing is running yet, so there is nothing to restart.
    renderActions("building");
    expect(controls()).toEqual(["Details", "Stop", "Destroy"]);
  });

  it("offers redeploy once the container has stopped", () => {
    renderActions("removed");
    expect(controls()).toEqual(["Details", "Redeploy", "Destroy"]);
  });

  it("offers redeploy to a service whose deploy was refused", () => {
    // The orphan with no deployment at all: before this feature its row held Destroy and
    // nothing else, which made a billable mistake a delete-and-retype.
    renderActions("unknown", null);
    expect(controls()).toEqual(["Details", "Redeploy", "Destroy"]);
  });

  it("offers the detail view in every state a lifecycle verb is absent from", () => {
    /*
     * Editing is not in `availableActions` and this is why: that list answers "would this
     * mutation do anything to the running deployment", and every state has a description to
     * change — including the one with no deployment at all, where an unrunnable image is
     * exactly what a person needs to fix.
     */
    renderActions("unknown", null);
    expect(screen.getByRole("button", { name: /^details$/i })).toBeEnabled();
  });

  it("keeps the detail view open while the container is being removed", () => {
    /*
     * The one control here that stays live in `removing`, and the split is what folding
     * edit into a detail view bought. Destroy is dimmed because it must not promise
     * something another state would deliver. The facts about a container on its way out
     * are still facts — so the dialog opens and only its edit mode is withheld, which
     * container-detail-dialog.test.tsx asserts from the inside.
     */
    renderActions("removing");
    expect(controls()).toEqual(["Details", "Destroy"]);
    expect(screen.getByRole("button", { name: /destroy/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^details$/i })).toBeEnabled();
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
