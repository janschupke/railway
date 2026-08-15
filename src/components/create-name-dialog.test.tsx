import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionResult } from "@/lib/action-result";

const action = vi.fn<(prev: unknown, formData: FormData) => Promise<ActionResult>>();

const { CreateNameDialog } = await import("./create-name-dialog");
type CreateNameChoice = import("./create-name-dialog").CreateNameChoice;
const { ToastProvider } = await import("./ui/toast");

const copy = {
  trigger: "New project",
  title: "Create a project",
  description: "This creates a project on your own Railway account.",
  label: "Project name",
  placeholder: "My project",
  submit: "Create project",
  submitPending: "Creating…",
  announce: "Creating project…",
  failedTitle: "The project could not be created",
};

const onCreated = vi.fn();

/** The workspace select, as create-dialogs.tsx builds it for an account with one. */
const choice: CreateNameChoice = {
  name: "workspaceId",
  label: "Where it goes",
  options: [
    { value: "", label: "Personal account" },
    { value: "ws_1", label: "Acme" },
  ],
};

function renderDialog(
  over: {
    hidden?: Record<string, string>;
    choice?: CreateNameChoice;
    disabled?: boolean;
  } = {},
) {
  return render(
    <ToastProvider>
      <CreateNameDialog
        action={action}
        field="projectName"
        copy={copy}
        onCreated={onCreated}
        {...over}
      />
    </ToastProvider>,
  );
}

const open = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: "New project" }));
  const dialog = await screen.findByRole("dialog");
  await screen.findByLabelText("Project name");
  return dialog;
};

describe("CreateNameDialog", () => {
  beforeEach(() => {
    action.mockReset();
    action.mockResolvedValue({
      ok: true,
      message: "Created Client work",
      select: { projectId: "proj_new", environmentId: "env_new" },
    });
    onCreated.mockClear();
  });

  it("is a dialog, not an alertdialog", async () => {
    /*
     * The distinction this component exists for. `alertdialog` interrupts and is announced
     * with its description first, which is right for the destroy confirmation and wrong for
     * a form the user opened on purpose.
     */
    const user = userEvent.setup();
    renderDialog();
    await open(user);

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveTextContent("Create a project");
  });

  it("submits the typed name and hands the selection back", async () => {
    const user = userEvent.setup();
    renderDialog({ hidden: { projectId: "p1" } });
    await open(user);

    await user.type(screen.getByLabelText("Project name"), "Client work");
    await user.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const formData = action.mock.calls[0]?.[1];
    expect(formData?.get("projectName")).toBe("Client work");
    // Hidden values the user does not type still reach the action.
    expect(formData?.get("projectId")).toBe("p1");

    expect(onCreated).toHaveBeenCalledWith({
      projectId: "proj_new",
      environmentId: "env_new",
    });
  });

  it("closes on success and says so in a toast", async () => {
    const user = userEvent.setup();
    renderDialog();
    await open(user);

    await user.type(screen.getByLabelText("Project name"), "Client work");
    await user.click(screen.getByRole("button", { name: "Create project" }));

    // The toast outlives the dialog, which is the reason it is a toast at all.
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByText("Created Client work")).toBeInTheDocument();
  });

  it("renders a field-attributed error inline and stays open", async () => {
    action.mockResolvedValue({
      ok: false,
      field: "projectName",
      error: "Keep the name under 64 characters",
    });
    const user = userEvent.setup();
    renderDialog();
    await open(user);

    await user.type(screen.getByLabelText("Project name"), "Client work");
    await user.click(screen.getByRole("button", { name: "Create project" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Keep the name under 64 characters",
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // What was typed survives, so the fix is an edit rather than a retype.
    expect(screen.getByLabelText("Project name")).toHaveValue("Client work");
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("toasts an error that belongs to no field on screen", async () => {
    action.mockResolvedValue({ ok: false, error: "Railway refused this operation." });
    const user = userEvent.setup();
    renderDialog();
    await open(user);

    await user.type(screen.getByLabelText("Project name"), "Client work");
    await user.click(screen.getByRole("button", { name: "Create project" }));

    expect(
      await screen.findByText("Railway refused this operation."),
    ).toBeInTheDocument();
    // Still open: the user's input is the only copy of what they were doing.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("attributes an error for a different field to the toast, not this input", async () => {
    // A guard on the `field` prop being both the input name and the ActionField: a rename
    // on one side only would otherwise silently mis-route every server error.
    action.mockResolvedValue({
      ok: false,
      field: "environmentName",
      error: "Give the environment a name",
    });
    const user = userEvent.setup();
    renderDialog();
    await open(user);

    await user.type(screen.getByLabelText("Project name"), "Client work");
    await user.click(screen.getByRole("button", { name: "Create project" }));

    expect(await screen.findByText("Give the environment a name")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("forgets the previous attempt's error and value when reopened", async () => {
    action.mockResolvedValue({
      ok: false,
      field: "projectName",
      error: "Give the project a name",
    });
    const user = userEvent.setup();
    renderDialog();
    await open(user);

    await user.type(screen.getByLabelText("Project name"), "x");
    await user.click(screen.getByRole("button", { name: "Create project" }));
    await screen.findByRole("alert");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await open(user);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Project name")).toHaveValue("");
  });

  it("draws no second control when the caller passes no choice", async () => {
    // The environment dialog, and a personal-only account: nothing to choose, nothing
    // drawn, and nothing extra in the submission.
    const user = userEvent.setup();
    renderDialog();
    await open(user);

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Project name"), "Client work");
    await user.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0]?.[1].has("workspaceId")).toBe(false);
  });

  it("submits the chosen option under the name the caller gave it", async () => {
    const user = userEvent.setup();
    renderDialog({ choice });
    await open(user);

    await user.type(screen.getByLabelText("Project name"), "Client work");
    await user.click(screen.getByRole("combobox", { name: "Where it goes" }));
    await user.click(await screen.findByRole("option", { name: "Acme" }));
    await user.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const formData = action.mock.calls[0]?.[1];
    expect(formData?.get("projectName")).toBe("Client work");
    expect(formData?.get("workspaceId")).toBe("ws_1");
  });

  it("submits the resting option as blank rather than as a sentinel", async () => {
    /*
     * The Select stands an unsubmittable placeholder in for the empty string, because Radix
     * refuses a blank item value. Nothing outside that component may ever see it — this is
     * the assertion that says so from the far side of the form.
     */
    const user = userEvent.setup();
    renderDialog({ choice });
    await open(user);

    await user.type(screen.getByLabelText("Project name"), "Client work");
    await user.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0]?.[1].get("workspaceId")).toBe("");
  });

  it("forgets the chosen option when reopened", async () => {
    // Same rule as the name above it, and a sharper consequence: a create that silently
    // reused the last attempt's destination would put a project somewhere nobody chose.
    action.mockResolvedValue({
      ok: false,
      field: "projectName",
      error: "Give the project a name",
    });
    const user = userEvent.setup();
    renderDialog({ choice });
    await open(user);

    await user.click(screen.getByRole("combobox", { name: "Where it goes" }));
    await user.click(await screen.findByRole("option", { name: "Acme" }));
    expect(screen.getByRole("combobox", { name: "Where it goes" })).toHaveTextContent(
      "Acme",
    );
    await user.type(screen.getByLabelText("Project name"), "x");
    await user.click(screen.getByRole("button", { name: "Create project" }));
    await screen.findByRole("alert");
    // The choice survives a failed submit, which is what the value living in state buys.
    expect(screen.getByRole("combobox", { name: "Where it goes" })).toHaveTextContent(
      "Acme",
    );

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await open(user);

    expect(screen.getByRole("combobox", { name: "Where it goes" })).toHaveTextContent(
      "Personal account",
    );
  });

  it("explains an empty choice instead of drawing a dropdown that opens on nothing", async () => {
    const user = userEvent.setup();
    renderDialog({
      choice: {
        ...choice,
        options: [],
        disabledReason: "Railway withheld workspace:viewer at consent.",
      },
    });
    await open(user);

    expect(screen.getByRole("combobox", { name: "Where it goes" })).toBeDisabled();
    expect(
      screen.getByText("Railway withheld workspace:viewer at consent."),
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText("Project name"), "Client work");
    await user.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    // A disabled control is skipped by the form-data algorithm, so the action is told
    // nothing rather than told the empty string — either way it means personal.
    expect(action.mock.calls[0]?.[1].has("workspaceId")).toBe(false);
  });

  it("cannot be opened when disabled", async () => {
    const user = userEvent.setup();
    renderDialog({ disabled: true });

    const trigger = screen.getByRole("button", { name: "New project" });
    expect(trigger).toBeDisabled();
    await user.click(trigger);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    renderDialog();
    await open(user);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(action).not.toHaveBeenCalled();
  });

  describe("controlled", () => {
    /*
     * The shape the pickers use, where the affordance is a row inside a dropdown rather
     * than a button of this component's own. The uncontrolled path above is untouched by
     * it, which is what keeps the empty state's primary "Create a project" working.
     */
    const renderControlled = (open: boolean, onOpenChange = vi.fn()) => {
      const result = render(
        <ToastProvider>
          <CreateNameDialog
            action={action}
            field="projectName"
            copy={copy}
            onCreated={onCreated}
            open={open}
            onOpenChange={onOpenChange}
          />
        </ToastProvider>,
      );
      return { ...result, onOpenChange };
    };

    it("renders no trigger of its own", () => {
      renderControlled(false);
      expect(screen.queryByRole("button", { name: "New project" })).toBeNull();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("opens from the prop alone", () => {
      renderControlled(true);
      expect(screen.getByRole("dialog")).toBeVisible();
      expect(screen.getByLabelText("Project name")).toBeVisible();
    });

    it("reports a dismissal instead of closing itself", async () => {
      // The caller owns the state, so this must ask rather than act — a component that
      // closed itself here would leave the two out of step on the next render.
      const user = userEvent.setup();
      const { onOpenChange } = renderControlled(true);

      await user.keyboard("{Escape}");

      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
      expect(action).not.toHaveBeenCalled();
    });

    it("reports the close that follows a successful create", async () => {
      action.mockResolvedValue({ ok: true, message: "Created Client work" });
      const user = userEvent.setup();
      const { onOpenChange } = renderControlled(true);

      await user.type(screen.getByLabelText("Project name"), "Client work");
      await user.click(screen.getByRole("button", { name: "Create project" }));

      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
      expect(onCreated).toHaveBeenCalled();
    });
  });
});
