import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  return screen.findByRole("alertdialog");
};

describe("DestroyContainerDialog", () => {
  beforeEach(() => {
    spinDown.mockReset();
    spinDown.mockResolvedValue({ ok: true, message: "Destroyed cache" });
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

    await user.type(screen.getByLabelText(/type "cache" to confirm/i), "cach");
    expect(confirm).toBeDisabled();

    await user.type(screen.getByLabelText(/type "cache" to confirm/i), "e");
    expect(confirm).toBeEnabled();
  });

  it("does not call the action while the confirmation is incomplete", async () => {
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);

    await user.type(screen.getByLabelText(/type "cache" to confirm/i), "wrong");
    await user.click(screen.getByRole("button", { name: /destroy permanently/i }));

    expect(spinDown).not.toHaveBeenCalled();
  });

  it("submits the service reference the server needs to re-check ownership", async () => {
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);

    await user.type(screen.getByLabelText(/type "cache" to confirm/i), "cache");
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

    await user.type(screen.getByLabelText(/type "cache" to confirm/i), "cache");
    await user.click(screen.getByRole("button", { name: /destroy permanently/i }));

    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    expect(await screen.findByText("Destroyed cache")).toBeInTheDocument();
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

    await user.type(screen.getByLabelText(/type "cache" to confirm/i), "cache");
    await user.click(screen.getByRole("button", { name: /destroy permanently/i }));

    expect(await screen.findByText(/was not created here/i)).toBeInTheDocument();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("clears the typed confirmation when cancelled", async () => {
    // Reopening with the name still filled in would defeat the guard.
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);

    await user.type(screen.getByLabelText(/type "cache" to confirm/i), "cache");
    await user.click(screen.getByRole("button", { name: /cancel/i }));

    await openDialog(user);
    expect(screen.getByLabelText(/type "cache" to confirm/i)).toHaveValue("");
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
