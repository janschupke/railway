import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { routerMock } from "@/test/setup-dom";
import { ProjectPicker } from "./project-picker";

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

const renderPicker = (
  projectId: string | null = "p1",
  environmentId: string | null = "e1",
) =>
  render(
    <ProjectPicker
      projects={projects}
      projectId={projectId}
      environmentId={environmentId}
    />,
  );

beforeEach(() => {
  routerMock.push.mockClear();
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

  it("distinguishes a project with no environments from no project at all", () => {
    render(
      <ProjectPicker
        projects={[{ id: "p3", name: "Bare", environments: [] }]}
        projectId="p3"
        environmentId={null}
      />,
    );

    // Same greyed-out control, different cause, and only one of them is the user's to
    // act on. Previously both rendered an enabled trigger opening an empty popup.
    expect(screen.getByRole("combobox", { name: "Environment" })).toBeDisabled();
    expect(screen.getByText("This project has no environments.")).toBeInTheDocument();
  });
});
