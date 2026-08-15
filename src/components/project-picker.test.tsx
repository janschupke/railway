import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routerMock } from "@/test/setup-dom";
import type { ActionResult } from "@/lib/action-result";

const createProject = vi.fn<() => Promise<ActionResult>>();
const createEnvironment = vi.fn<() => Promise<ActionResult>>();
vi.mock("@/app/dashboard/actions", () => ({
  createProject: () => createProject(),
  createEnvironment: () => createEnvironment(),
}));

const { ProjectPicker } = await import("./project-picker");
const { ToastProvider } = await import("./ui/toast");

const projects = [
  {
    id: "p1",
    name: "Demo",
    environments: [
      { id: "e1", name: "production" },
      { id: "e2", name: "staging" },
    ],
  },
  { id: "p2", name: "Other", environments: [{ id: "e3", name: "production" }] },
];

const workspaces = [{ id: "ws1", name: "Acme" }];

const renderPicker = (
  projectId: string | null = "p1",
  environmentId: string | null = "e1",
) =>
  render(
    // The picker's create dialogs raise toasts, and useToast throws outside a provider —
    // the dashboard layout is what supplies it in the app.
    <ToastProvider>
      <ProjectPicker
        projects={projects}
        projectId={projectId}
        environmentId={environmentId}
        workspaces={workspaces}
        deniedWorkspaces={false}
      />
    </ToastProvider>,
  );

/**
 * Opens a create dialog the way the UI now offers it: through the dropdown it belongs to.
 *
 * `findBy` rather than `getBy` on the field, and that is not incidental — the dialog opens
 * one animation frame after the row is clicked, because a Select popup has to finish
 * tearing its modal layer down before a Dialog may put one up.
 */
const openCreate = async (
  user: UserEvent,
  control: "Project" | "Environment",
  row: string,
  field: string,
) => {
  await user.click(screen.getByRole("combobox", { name: control }));
  await user.click(await screen.findByRole("option", { name: row }));
  return screen.findByLabelText(field);
};

beforeEach(() => {
  routerMock.push.mockClear();
  createProject.mockReset();
  createEnvironment.mockReset();
});

describe("ProjectPicker", () => {
  it("shows the current selection in both controls", () => {
    renderPicker();
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveTextContent("Demo");
    expect(screen.getByRole("combobox", { name: "Environment" })).toHaveTextContent(
      "production",
    );
  });

  it("puts the selection in the URL, so the view is linkable", async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole("combobox", { name: "Environment" }));
    await user.click(await screen.findByRole("option", { name: "staging" }));

    expect(routerMock.push).toHaveBeenCalledWith("/dashboard?environment=e2");
  });

  it("drops the environment when the project changes", async () => {
    // The old environment id belongs to the old project; the server picks the default.
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole("combobox", { name: "Project" }));
    await user.click(await screen.findByRole("option", { name: "Other" }));

    const target = routerMock.push.mock.calls.at(-1)?.[0] as string;
    expect(target).toContain("project=p2");
    expect(target).not.toContain("environment");
  });

  it("offers only the selected project's environments", async () => {
    const user = userEvent.setup();
    renderPicker("p2", "e3");

    await user.click(screen.getByRole("combobox", { name: "Environment" }));

    expect(
      await screen.findByRole("option", { name: "production" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "staging" })).toBeNull();
  });

  it("labels both controls visibly, not only in the accessibility tree", () => {
    // These were the only controls in the app whose names existed nowhere on screen:
    // an aria-label reads to a screen reader and to nobody else.
    renderPicker();

    for (const name of ["Project", "Environment"]) {
      const label = screen.getByText(name);
      expect(label.tagName).toBe("LABEL");
      expect(label).toHaveAttribute("for", screen.getByRole("combobox", { name }).id);
    }
  });

  it("disables the environment control when no project resolves, and says why", () => {
    renderPicker(null, null);

    const environment = screen.getByRole("combobox", { name: "Environment" });
    expect(environment).toBeDisabled();
    // A dimmed control states that something is unavailable and nothing about why.
    expect(screen.getByText("Choose a project first.")).toBeInTheDocument();
  });

  it("distinguishes a project with no environments from no project at all", async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <ProjectPicker
          projects={[{ id: "p3", name: "Bare", environments: [] }]}
          projectId="p3"
          environmentId={null}
          workspaces={workspaces}
          deniedWorkspaces={false}
        />
      </ToastProvider>,
    );

    /*
     * Two causes, and they now get two different controls rather than the same dim one.
     * Nothing to choose from is no longer a dead end here: the popup holds the row that
     * fixes it, which is the case the always-disabled "New environment" button covered
     * before it moved inside.
     */
    const environment = screen.getByRole("combobox", { name: "Environment" });
    expect(environment).toBeEnabled();
    expect(screen.getByText("This project has no environments.")).toBeInTheDocument();

    await user.click(environment);
    const listbox = await screen.findByRole("listbox");
    expect(within(listbox).getAllByRole("option")).toHaveLength(1);
    expect(
      within(listbox).getByRole("option", { name: "New environment" }),
    ).toBeVisible();
  });

  it("offers the account's workspaces in the create dialog, personal first", async () => {
    const user = userEvent.setup();
    renderPicker();

    await openCreate(user, "Project", "New project", "Project name");

    await user.click(screen.getByRole("combobox", { name: "Where it goes" }));
    const listbox = await screen.findByRole("listbox");
    // Order matters: the first row is the resting state, and it has to be the one that
    // keeps the behaviour this app had before the choice existed.
    expect(
      within(listbox)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Personal account", "Acme"]);
  });

  it("lands on a project it just created, with its default environment", async () => {
    createProject.mockResolvedValue({
      ok: true,
      message: "Created Client work",
      select: { projectId: "p9", environmentId: "e9" },
    });
    const user = userEvent.setup();
    renderPicker();

    await user.type(
      await openCreate(user, "Project", "New project", "Project name"),
      "Client work",
    );
    await user.click(screen.getByRole("button", { name: "Create project" }));

    /*
     * The whole reason the action returns ids rather than only a message. Creating a
     * project and leaving the user on the list they were looking at is the dead end this
     * feature exists to remove.
     */
    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith(
        "/dashboard?project=p9&environment=e9",
      ),
    );
    expect(routerMock.push).toHaveBeenCalledTimes(1);
  });

  it("drops the old environment when the new project came without one", async () => {
    createProject.mockResolvedValue({
      ok: true,
      message: "Created Bare",
      select: { projectId: "p9" },
    });
    const user = userEvent.setup();
    renderPicker();

    await user.type(
      await openCreate(user, "Project", "New project", "Project name"),
      "Bare",
    );
    await user.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(routerMock.push).toHaveBeenCalled());
    const target = routerMock.push.mock.calls.at(-1)?.[0] as string;
    // Carrying the previous project's environment forward would name an environment that
    // belongs to somewhere else — the server drops it anyway, but a render later.
    expect(target).toContain("project=p9");
    expect(target).not.toContain("environment");
  });

  it("navigates nowhere when a create reports success without ids", async () => {
    // Nothing in the app produces this today. The guard exists because `select` is
    // optional on the result type, and a pushed URL built from `undefined` is worse than
    // staying put.
    createProject.mockResolvedValue({ ok: true, message: "Created Bare" });
    const user = userEvent.setup();
    renderPicker();

    await user.type(
      await openCreate(user, "Project", "New project", "Project name"),
      "Bare",
    );
    await user.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  it("lands on an environment it just created, in the project it was made in", async () => {
    createEnvironment.mockResolvedValue({
      ok: true,
      message: "Created staging",
      select: { projectId: "p1", environmentId: "e9" },
    });
    const user = userEvent.setup();
    renderPicker();

    await user.type(
      await openCreate(user, "Environment", "New environment", "Environment name"),
      "staging",
    );
    await user.click(screen.getByRole("button", { name: "Create environment" }));

    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith(
        "/dashboard?project=p1&environment=e9",
      ),
    );
  });

  it("cannot create an environment before a project is chosen", async () => {
    /*
     * There is nothing to create an environment in, so the row is not offered — and the
     * control it would have lived in is the thing that says why. That is a strict
     * improvement on the dimmed button it replaced, which stated that something was
     * unavailable and nothing about what.
     */
    const user = userEvent.setup();
    renderPicker(null, null);

    expect(screen.getByRole("combobox", { name: "Environment" })).toBeDisabled();
    expect(screen.getByText("Choose a project first.")).toBeInTheDocument();

    // Creating a project, meanwhile, is always available.
    await user.click(screen.getByRole("combobox", { name: "Project" }));
    expect(await screen.findByRole("option", { name: "New project" })).toBeVisible();
  });

  it("never reports the create row as a selection", async () => {
    /*
     * The property the whole action-row mechanism exists for. A create row that came back
     * through `onValueChange` would hand `selectProject` a value that is not a project id,
     * and the URL — which is this app's only state — would carry it.
     */
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole("combobox", { name: "Project" }));
    await user.click(await screen.findByRole("option", { name: "New project" }));

    await screen.findByLabelText("Project name");
    expect(routerMock.push).not.toHaveBeenCalled();
  });
});
