import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routerMock } from "@/test/setup-dom";
import type { ActionResult } from "@/lib/action-result";
import type { ContainerAction } from "@/lib/container-actions";

const run = vi.fn<(prev: unknown, formData: FormData) => Promise<ActionResult>>();

const { LifecycleActionDialog } = await import("./lifecycle-action-dialog");
const { ToastProvider } = await import("./ui/toast");

function renderDialog(action: ContainerAction = "stop") {
  return render(
    <ToastProvider>
      <LifecycleActionDialog
        action={action}
        serviceId="svc_1"
        displayName="cache"
        projectId="p1"
        environmentId="e1"
        icon={<span data-testid="icon" />}
        run={run}
      />
    </ToastProvider>,
  );
}

const open = async (user: ReturnType<typeof userEvent.setup>, trigger: RegExp) => {
  await user.click(screen.getByRole("button", { name: trigger }));
  return screen.findByRole("alertdialog");
};

describe("LifecycleActionDialog", () => {
  beforeEach(() => {
    run.mockReset();
    run.mockResolvedValue({ ok: true, message: "Stopped cache" });
    // Shared across the file; without this a call count is a running total.
    routerMock.refresh.mockClear();
  });

  it("confirms without asking anyone to type a container name", async () => {
    /*
     * The distinction this component exists to draw. Stopping is reversible, so it gets a
     * sentence and two buttons — and it must NOT get the destroy dialog's typed
     * confirmation, because friction spent where it is not needed is friction the destroy
     * dialog no longer has.
     */
    const user = userEvent.setup();
    renderDialog("stop");
    const dialog = await open(user, /^stop$/i);

    expect(dialog).toHaveTextContent("Stop cache?");
    expect(dialog).toHaveTextContent(/Redeploy starts it again/i);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /stop container/i })).toBeEnabled();
  });

  it.each([
    ["stop", /^stop$/i, "Stop cache?", /stop container/i],
    ["restart", /^restart$/i, "Restart cache?", /restart container/i],
    ["redeploy", /^redeploy$/i, "Redeploy cache?", /redeploy container/i],
  ] as const)(
    "renders the %s verb's own copy",
    async (action, trigger, title, submit) => {
      // One component, three verbs: the copy is the only thing that differs, so the only
      // way a wrong namespace shows up is an assertion per verb.
      const user = userEvent.setup();
      renderDialog(action);
      const dialog = await open(user, trigger);

      expect(dialog).toHaveTextContent(title);
      expect(screen.getByRole("button", { name: submit })).toBeInTheDocument();
    },
  );

  it("submits the three ids the server re-derives ownership from", async () => {
    const user = userEvent.setup();
    renderDialog();
    await open(user, /^stop$/i);

    await user.click(screen.getByRole("button", { name: /stop container/i }));

    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    const formData = run.mock.calls[0]?.[1];
    expect(formData?.get("serviceId")).toBe("svc_1");
    expect(formData?.get("projectId")).toBe("p1");
    expect(formData?.get("environmentId")).toBe("e1");
    // No deployment id: the server reads that off Railway's own answer, never the form.
    expect(formData?.get("deploymentId")).toBeNull();
  });

  it("closes, reports success and pulls the fresh list", async () => {
    const user = userEvent.setup();
    renderDialog();
    await open(user, /^stop$/i);

    await user.click(screen.getByRole("button", { name: /stop container/i }));

    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    expect(await screen.findByText("Stopped cache")).toBeInTheDocument();
    await waitFor(() => expect(routerMock.refresh).toHaveBeenCalledTimes(1));
  });

  it("stays open and surfaces the reason when the server refuses", async () => {
    // The ownership refusal, or a stale row acting on a container that has gone. Either
    // way the dialog is where the user is looking, so it stays there.
    run.mockResolvedValue({
      ok: false,
      error: "This service was not created here, so this app cannot act on it.",
    });

    const user = userEvent.setup();
    renderDialog();
    await open(user, /^stop$/i);

    await user.click(screen.getByRole("button", { name: /stop container/i }));

    expect(await screen.findByText(/was not created here/i)).toBeInTheDocument();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("does nothing when cancelled", async () => {
    const user = userEvent.setup();
    renderDialog();
    await open(user, /^stop$/i);

    await user.click(screen.getByRole("button", { name: /cancel/i }));

    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    renderDialog();
    await open(user, /^stop$/i);

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    expect(run).not.toHaveBeenCalled();
  });
});
