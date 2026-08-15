import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ToastProvider } from "@/components/ui/toast";
import type { RailwayProject } from "@/lib/railway/types";
import { DashboardFrame } from "./dashboard-frame";
import type { DashboardShell } from "./dashboard-types";

const project: RailwayProject = {
  id: "p1",
  name: "Ledger",
  environments: [{ id: "e1", name: "production" }],
};

const shell = (over: Partial<DashboardShell> = {}): DashboardShell => ({
  user: { name: "Jan" },
  projects: [project],
  workspaces: [],
  project,
  environment: project.environments[0] ?? null,
  error: null,
  partialError: null,
  errorKind: null,
  missingScopes: [],
  droppedSelection: false,
  ...over,
});

const renderFrame = async (over: Partial<DashboardShell> = {}) =>
  render(
    // The picker's create rows open dialogs that toast their outcome. Provided here
    // rather than stubbed away: the dashboard layout owns it in production.
    <ToastProvider>
      {await DashboardFrame({ shell: shell(over), children: <p>tab content</p> })}
    </ToastProvider>,
  );

describe("DashboardFrame", () => {
  it("gives the three tabs one page heading, and hides it", async () => {
    // The picker directly below names the project and environment; a visible title here
    // would restate what the next control already says. The outline still needs it.
    await renderFrame();

    const heading = screen.getByRole("heading", { level: 1, name: "Dashboard" });
    expect(heading).toHaveClass("sr-only");
  });

  it("draws the picker and the tab's own content when there are projects", async () => {
    await renderFrame();

    expect(screen.getByText("tab content")).toBeInTheDocument();
    expect(screen.getByLabelText("Project")).toBeInTheDocument();
    expect(screen.getByLabelText("Environment")).toBeInTheDocument();
  });

  describe("a failed project read", () => {
    it("offers re-consent for a credential Railway rejected", async () => {
      await renderFrame({ error: "Authorization expired.", errorKind: "auth" });

      expect(screen.getByRole("link", { name: "Re-authorize" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    });

    it("offers a retry for anything else, because re-consent cannot fix it", async () => {
      // Pairing every failure with a sign-in link is how "re-authorize" became the button
      // that never works.
      await renderFrame({
        error: "Railway is rate limiting.",
        errorKind: "rate_limit",
      });

      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Re-authorize" })).toBeNull();
    });

    it("renders no picker and no tab content, because there is nothing to pick", async () => {
      /*
       * The failure this branch exists for: the page used to draw the whole interactive
       * shell anyway, so a broken authorization presented as an enabled Project dropdown
       * that opened an empty popup and explained nothing.
       */
      await renderFrame({ error: "Railway is down.", errorKind: null });

      expect(screen.queryByText("tab content")).toBeNull();
      expect(screen.queryByLabelText("Project")).toBeNull();
    });
  });

  describe("an empty project list", () => {
    it("leads with creating one when the account is simply empty", async () => {
      await renderFrame({ projects: [], project: null, environment: null });

      expect(screen.getByText("No projects to show")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Create a project" }),
      ).toBeInTheDocument();
      expect(screen.queryByText("tab content")).toBeNull();
    });

    it("leads with re-consent when a withheld scope caused the empty list", async () => {
      // Offering a create here would be a second button refused by the same scope.
      await renderFrame({
        projects: [],
        project: null,
        environment: null,
        missingScopes: ["project:admin"],
      });

      expect(screen.getByText("This app was not granted project access")).toBeVisible();
      expect(screen.queryByRole("button", { name: "Create a project" })).toBeNull();
    });
  });

  it("says when part of the project list is missing", async () => {
    // A list that is real but incomplete must say so; showing what happened to load with
    // no sign that a whole workspace was refused is how someone concludes their projects
    // are gone.
    await renderFrame({ partialError: "One workspace could not be read." });

    expect(screen.getByText("One workspace could not be read.")).toBeInTheDocument();
    expect(screen.getByText("tab content")).toBeInTheDocument();
  });

  it("says when the link named a project that is no longer there", async () => {
    await renderFrame({ droppedSelection: true });

    expect(screen.getByText(/no longer available/)).toBeInTheDocument();
  });
});
