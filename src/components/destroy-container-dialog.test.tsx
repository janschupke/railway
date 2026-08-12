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

function renderDialog() {
  return render(
    <ToastProvider>
      <DestroyContainerDialog
        serviceId="svc_1"
        displayName="cache"
        projectId="p1"
        environmentId="e1"
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
