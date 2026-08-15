import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routerMock } from "@/test/setup-dom";
import type { ActionResult } from "@/lib/action-result";

const spinDown = vi.fn<(prev: unknown, formData: FormData) => Promise<ActionResult>>();
vi.mock("@/app/dashboard/actions", () => ({
  spinDown: (prev: unknown, formData: FormData) => spinDown(prev, formData),
}));

const { DestroyContainerDialog } = await import("./destroy-container-dialog");
const { ToastProvider } = await import("./ui/toast");

function renderDialog(props: { volumeSize?: string } = {}) {
  return render(
    <ToastProvider>
      <DestroyContainerDialog
        serviceId="svc_1"
        displayName="cache"
        projectId="p1"
        environmentId="e1"
        {...props}
      />
    </ToastProvider>,
  );
}

const openDialog = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: /destroy/i }));
  const dialog = await screen.findByRole("alertdialog");
  /*
   * The dialog shell renders immediately; its body is a dynamic import that lands a
   * tick later. Waiting for the confirm field means every spec below acts on a fully
   * mounted form rather than racing the chunk.
   */
  await screen.findByLabelText(/to confirm/i);
  return dialog;
};

describe("DestroyContainerDialog", () => {
  beforeEach(() => {
    spinDown.mockReset();
    spinDown.mockResolvedValue({ ok: true, message: "Destroyed cache" });
    // Shared across the file; without this a call count is a running total.
    routerMock.refresh.mockClear();
  });

  it("names the container in the confirmation, so the consequence is unambiguous", async () => {
    const user = userEvent.setup();
    renderDialog();
    const dialog = await openDialog(user);

    expect(dialog).toHaveTextContent("Destroy cache?");
    expect(dialog).toHaveTextContent(/cannot be undone/i);
  });

  it("keeps the destroy button disabled until the name matches exactly", async () => {
    // The whole point of the guard: a mis-aimed click must not delete infrastructure.
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);

    const confirm = screen.getByRole("button", { name: /destroy permanently/i });
    expect(confirm).toBeDisabled();

    await user.type(screen.getByLabelText(/type .cache. to confirm/i), "cach");
    expect(confirm).toBeDisabled();

    await user.type(screen.getByLabelText(/type .cache. to confirm/i), "e");
    expect(confirm).toBeEnabled();
  });

  it("does not call the action while the confirmation is incomplete", async () => {
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);

    await user.type(screen.getByLabelText(/type .cache. to confirm/i), "wrong");
    await user.click(screen.getByRole("button", { name: /destroy permanently/i }));

    expect(spinDown).not.toHaveBeenCalled();
  });

  it("submits the service reference the server needs to re-check ownership", async () => {
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);

    await user.type(screen.getByLabelText(/type .cache. to confirm/i), "cache");
    await user.click(screen.getByRole("button", { name: /destroy permanently/i }));

    await waitFor(() => expect(spinDown).toHaveBeenCalledTimes(1));
    const formData = spinDown.mock.calls[0]?.[1];
    expect(formData?.get("serviceId")).toBe("svc_1");
    expect(formData?.get("projectId")).toBe("p1");
    expect(formData?.get("environmentId")).toBe("e1");
  });

  it("closes and reports success", async () => {
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);

    await user.type(screen.getByLabelText(/type .cache. to confirm/i), "cache");
    await user.click(screen.getByRole("button", { name: /destroy permanently/i }));

    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    expect(await screen.findByText("Destroyed cache")).toBeInTheDocument();
  });

  it("pulls the fresh list once the destroy succeeds", async () => {
    /*
     * Only the call is asserted, not the busy window it opens. `refresh` is a no-op spy
     * here, so the transition wrapping it resolves in the same tick and there is no
     * pending state to observe — in the browser it stays pending for the whole Railway
     * round trip, which is the point of the transition. e2e/skeleton.spec.ts covers
     * that the trigger is inert while it runs.
     */
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);

    await user.type(screen.getByLabelText(/type .cache. to confirm/i), "cache");
    await user.click(screen.getByRole("button", { name: /destroy permanently/i }));

    await waitFor(() => expect(routerMock.refresh).toHaveBeenCalledTimes(1));
  });

  it("stays open and surfaces the reason when the server refuses", async () => {
    // e.g. the service was not created by this app — the user needs to see why.
    spinDown.mockResolvedValue({
      ok: false,
      error: "This service was not created here, so it cannot be destroyed here.",
    });

    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);

    await user.type(screen.getByLabelText(/type .cache. to confirm/i), "cache");
    await user.click(screen.getByRole("button", { name: /destroy permanently/i }));

    expect(await screen.findByText(/was not created here/i)).toBeInTheDocument();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("clears the typed confirmation when cancelled", async () => {
    // Reopening with the name still filled in would defeat the guard.
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);

    await user.type(screen.getByLabelText(/type .cache. to confirm/i), "cache");
    await user.click(screen.getByRole("button", { name: /cancel/i }));

    await openDialog(user);
    expect(screen.getByLabelText(/type .cache. to confirm/i)).toHaveValue("");
    expect(screen.getByRole("button", { name: /destroy permanently/i })).toBeDisabled();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
  });
});

describe("the stored data", () => {
  beforeEach(() => {
    spinDown.mockReset();
    spinDown.mockResolvedValue({ ok: true, message: "Destroyed cache" });
    routerMock.refresh.mockClear();
  });

  /** Fills the confirmation and submits, which is the only way past the guard. */
  const confirm = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.type(screen.getByLabelText(/to confirm/i), "cache");
    await user.click(screen.getByRole("button", { name: /destroy permanently/i }));
    await waitFor(() => expect(spinDown).toHaveBeenCalledTimes(1));
    return spinDown.mock.calls[0]![1];
  };

  it("offers the choice only when there is data to lose", async () => {
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);

    expect(
      screen.queryByRole("checkbox", { name: /stored data/i }),
    ).not.toBeInTheDocument();
  });

  it("names the size, so the consequence is a quantity rather than a word", async () => {
    const user = userEvent.setup();
    renderDialog({ volumeSize: "500 MB" });
    await openDialog(user);

    expect(
      screen.getByRole("checkbox", { name: "Also delete the stored data (500 MB)" }),
    ).toBeInTheDocument();
  });

  it("defaults to taking the data with the container", async () => {
    /*
     * The volume was created by this app as part of creating this container and holds only
     * what that container wrote, so the default is the outcome that leaves nothing invisible
     * behind — a kept volume disappears from this UI along with its row and keeps being
     * billed. The typed name is still the guard.
     */
    const user = userEvent.setup();
    renderDialog({ volumeSize: "500 MB" });
    await openDialog(user);

    expect(screen.getByRole("checkbox", { name: /stored data/i })).toBeChecked();

    const formData = await confirm(user);
    expect(formData.get("deleteData")).toBe("on");
  });

  it("posts no field at all once the box is unchecked", async () => {
    // An unchecked checkbox contributes nothing to FormData, which is exactly the shape the
    // action reads: absent means keep, and keep is what a refused volume read degrades to.
    const user = userEvent.setup();
    renderDialog({ volumeSize: "500 MB" });
    await openDialog(user);

    await user.click(screen.getByRole("checkbox", { name: /stored data/i }));
    const formData = await confirm(user);

    expect(formData.get("deleteData")).toBeNull();
  });

  it("keeps the box unchecked when the destroy is refused, and on the retry too", async () => {
    /*
     * The worst thing React's automatic form reset did, and the reason no form here takes a
     * function action any more.
     *
     * The refusal leaves the dialog open with the confirmation still typed, so the button
     * stays armed — and the reset put the checkbox back to `defaultChecked`, which is
     * checked. Unchecking the box, being refused, and pressing Destroy again therefore
     * deleted the volume the user had just said to keep, with nothing on screen having
     * changed between the two clicks.
     *
     * Both halves are asserted because either alone would pass a broken fix: the DOM state
     * without the second submission would miss a regression in what is posted, and the
     * submission without the DOM state would not say why it happened.
     */
    spinDown.mockResolvedValue({
      ok: false,
      error: "Railway refused the request.",
    });

    const user = userEvent.setup();
    renderDialog({ volumeSize: "500 MB" });
    await openDialog(user);

    const box = screen.getByRole("checkbox", { name: /stored data/i });
    await user.click(box);
    await user.type(screen.getByLabelText(/to confirm/i), "cache");
    await user.click(screen.getByRole("button", { name: /destroy permanently/i }));

    await waitFor(() => expect(spinDown).toHaveBeenCalledTimes(1));
    expect(spinDown.mock.calls[0]![1].get("deleteData")).toBeNull();

    expect(await screen.findByText(/Railway refused the request/i)).toBeInTheDocument();
    expect(box).not.toBeChecked();

    // Armed already, because the confirmation survived — which is what made the reverted
    // checkbox reachable in one click.
    await user.click(screen.getByRole("button", { name: /destroy permanently/i }));
    await waitFor(() => expect(spinDown).toHaveBeenCalledTimes(2));
    expect(spinDown.mock.calls[1]![1].get("deleteData")).toBeNull();
  });

  it("says what keeping it costs, rather than leaving it to be inferred", async () => {
    const user = userEvent.setup();
    renderDialog({ volumeSize: "500 MB" });
    const dialog = await openDialog(user);

    expect(dialog).toHaveTextContent(/kept on Railway and continues to be billed/i);
  });
});
