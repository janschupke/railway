import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

const container = (
  deploymentId: string | null,
  over: Partial<Container> = {},
): Container => ({
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
  ...over,
});

function renderActions(
  state: ContainerState,
  deploymentId: string | null = "dep_1",
  over: Partial<Container> = {},
) {
  return render(
    <TooltipProvider>
      <ToastProvider>
        <ContainerActions
          container={container(deploymentId, over)}
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

/**
 * Opens the row's menu and hands back every command in it, by visible label.
 *
 * `menuitem`, not `button`. That is the change this file records: the row used to render
 * one Radix trigger per verb, so `getAllByRole("button")` WAS the list of what a row
 * offered. There is one trigger now and the verbs are menu items behind it — which also
 * means a disabled item carries `data-disabled` rather than the attribute, so
 * `toBeDisabled()` no longer says what it used to say about one.
 */
const openMenu = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: "Actions for cache" }));
  const menu = await screen.findByRole("menu");
  return within(menu)
    .getAllByRole("menuitem")
    .map((item) => item.textContent?.trim());
};

describe("ContainerActions", () => {
  it("offers stop and restart between the two things every row has", async () => {
    const user = userEvent.setup();
    renderActions("running");

    expect(await openMenu(user)).toEqual([
      "Details",
      "Open in Railway",
      "Stop",
      "Restart",
      "Destroy",
    ]);
  });

  it("offers only stop while the deployment is still building", async () => {
    // Nothing is running yet, so there is nothing to restart.
    const user = userEvent.setup();
    renderActions("building");

    expect(await openMenu(user)).toEqual([
      "Details",
      "Open in Railway",
      "Stop",
      "Destroy",
    ]);
  });

  it("offers redeploy once the container has stopped", async () => {
    const user = userEvent.setup();
    renderActions("removed");

    expect(await openMenu(user)).toEqual([
      "Details",
      "Open in Railway",
      "Redeploy",
      "Destroy",
    ]);
  });

  it("offers redeploy to a service whose deploy was refused", async () => {
    // The orphan with no deployment at all: before this feature its row held Destroy and
    // nothing else, which made a billable mistake a delete-and-retype.
    const user = userEvent.setup();
    renderActions("unknown", null);

    expect(await openMenu(user)).toEqual([
      "Details",
      "Open in Railway",
      "Redeploy",
      "Destroy",
    ]);
  });

  it("offers the detail view in every state a lifecycle verb is absent from", async () => {
    /*
     * Editing is not in `availableActions` and this is why: that list answers "would this
     * mutation do anything to the running deployment", and every state has a description to
     * change — including the one with no deployment at all, where an unrunnable image is
     * exactly what a person needs to fix.
     */
    const user = userEvent.setup();
    renderActions("unknown", null);

    expect(await openMenu(user)).toContain("Details");
  });

  it("withholds destroy, and only destroy, while the container is being removed", async () => {
    /*
     * Absent rather than dimmed, which is what the menu changed about this case. As a
     * button, Destroy was rendered disabled — a control that is present and inert reads as
     * "not yet" on a row where the answer is "never again". A menu has no such obligation:
     * the item is simply not one of the commands.
     *
     * Details stays, and the split is what folding edit into a detail view bought. The
     * facts about a container on its way out are still facts, so the dialog opens and only
     * its edit mode is withheld — container-detail-dialog.test.tsx asserts that from the
     * inside.
     */
    const user = userEvent.setup();
    renderActions("removing");

    expect(await openMenu(user)).toEqual(["Details", "Open in Railway"]);
  });

  it("never renders a disabled lifecycle control", async () => {
    /*
     * State-gated rather than rendered-and-disabled, deliberately. A disabled control is a
     * promise that something would happen in another state, and "Restart" on a container
     * that is still building is not a promise this app can keep — so the control is absent
     * rather than dimmed.
     */
    const user = userEvent.setup();
    renderActions("failed");

    const items = await openMenu(user);
    expect(items).toContain("Redeploy");
    expect(items).not.toContain("Stop");
    expect(screen.queryByRole("menuitem", { name: /^stop$/i })).not.toBeInTheDocument();
  });

  it("gives an unmanaged row the same menu with only what it may do", async () => {
    /*
     * One shape for the whole column. This row used to end in two bare buttons where every
     * other row ended in a cluster of four, so a reader scanning down had to work out why
     * — and the answer, that somebody else made the service, was on a tooltip.
     *
     * No lifecycle verb and no Destroy, which is not a rendering choice:
     * `withManagedContainer` refuses all four on the server whatever the browser sends, so
     * offering a dimmed one would promise a state that does not exist.
     */
    const user = userEvent.setup();
    renderActions("running", "dep_1", { managed: false, rawName: "postgres" });

    expect(await openMenu(user)).toEqual(["Details", "Open in Railway"]);
  });

  it("opens the dialog a command names, one frame after the menu closes", async () => {
    /*
     * The half of this component the item list cannot prove. Each dialog used to carry its
     * own trigger; a trigger inside a menu item unmounts the moment the menu closes, so
     * they are siblings of the menu opened by state instead — and the state has to be set a
     * frame later, because a menu is a modal layer whose scroll lock, `aria-hidden` and
     * `pointer-events: none` all unwind in the commit that closes it. A dialog mounted
     * inside that window mounts under a body that still refuses pointer events.
     *
     * Asserted through the dialog appearing rather than through the frame, because the
     * frame is the mechanism and the dialog is the behaviour.
     */
    const user = userEvent.setup();
    renderActions("running");

    await user.click(screen.getByRole("button", { name: "Actions for cache" }));
    await user.click(await screen.findByRole("menuitem", { name: /^stop$/i }));

    expect(await screen.findByRole("alertdialog")).toHaveTextContent("Stop cache?");
  });

  it("reaches each of the three dialogs from its own command", async () => {
    // One state, three dialogs, and nothing but the discriminant telling them apart — so
    // the case that matters is that a command opens ITS dialog rather than the first one.
    const user = userEvent.setup();
    renderActions("running");

    await user.click(screen.getByRole("button", { name: "Actions for cache" }));
    await user.click(await screen.findByRole("menuitem", { name: /^details$/i }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("cache");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for cache" }));
    await user.click(await screen.findByRole("menuitem", { name: /^destroy$/i }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(/destroy cache/i);
  });

  it("puts focus back on the trigger when a dialog closes", async () => {
    /*
     * Explicit, and it was measured rather than assumed. `select.tsx` gets this free — its
     * popup's focus restore leaves the trigger as `document.activeElement` when the dialog
     * mounts, so the dialog records it. A menu's restore has not run by the frame the
     * dialog mounts in, so the dialog records the body and returns focus there: a keyboard
     * user closing a dialog is dropped at the top of the document, halfway down a list.
     */
    const user = userEvent.setup();
    renderActions("running");

    const trigger = screen.getByRole("button", { name: "Actions for cache" });
    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: /^stop$/i }));
    await screen.findByRole("alertdialog");

    await user.keyboard("{Escape}");

    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("names the row it acts on, because a list of these all read alike", async () => {
    // The trigger carries no visible label, and "Actions" on nine rows is nine identical
    // controls to anyone reading the accessible names rather than the layout.
    renderActions("running");

    expect(screen.getByRole("button", { name: "Actions for cache" })).toBeEnabled();
  });
});
