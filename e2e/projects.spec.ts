import {
  button,
  chooseOption,
  expect,
  injectFaults,
  onlyVisible,
  openBillingTab,
  openCreateFromSelect,
  openNewContainerTab,
  signIn,
  test,
  toast,
} from "./support";

/**
 * Where the dashboard gets its project list, and what it says when it gets nothing.
 *
 * This is the gap that let the reported bug ship. The fixture used to answer
 * `me.projects` unconditionally, so every spec exercised the one shape that worked and
 * nothing ever rendered the empty state — while a real account saw an empty dashboard
 * and a "sign in again" instruction that could not fix it.
 *
 * Faults are injected before signing in: the project list is read during the render
 * that follows the OAuth redirect, so setting them afterwards would be too late.
 */

/** Signs in without waiting for a container list, which an empty account never renders. */
async function signInBare(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByRole("link", { name: /sign in with railway/i }).click();
  await page.waitForURL("**/dashboard**");
}

const projectSelect = (page: import("@playwright/test").Page) =>
  onlyVisible(page.getByRole("combobox", { name: "Project" }));

test.describe("project sources", () => {
  test("lists projects that hang off a workspace, not the viewer", async ({ page }) => {
    // The regression test for the report: a project exists, and the dashboard said
    // there were none because it only ever asked one of Railway's two connections.
    await injectFaults(page, { projectsSource: "workspace" });
    await signInBare(page);

    await expect(projectSelect(page)).toContainText("Demo Project");
    await expect(onlyVisible(page.getByText("No projects to show"))).toBeHidden();
  });

  test("still lists projects when Railway refuses the workspace source", async ({
    page,
  }) => {
    /*
     * The regression that made this dashboard unusable. A token without a workspace
     * scope gets `me.workspaces` refused, and because the sources shared one document
     * the refusal discarded the personal project list along with it — every load, with
     * "Railway rejected the operation" and a Retry that could never work.
     */
    await injectFaults(page, { projectsSource: "personal", rejectWorkspaces: true });
    await signInBare(page);

    await expect(projectSelect(page)).toContainText("Demo Project");
    // Incomplete, and it says so: the refused source is named rather than hidden.
    await expect(onlyVisible(page.getByText(/workspace:viewer/))).toBeVisible();
  });

  test("shows a project reachable through both connections exactly once", async ({
    page,
  }) => {
    await injectFaults(page, { projectsSource: "both" });
    await signInBare(page);

    await projectSelect(page).click();
    await expect(
      onlyVisible(page.getByRole("option", { name: "Demo Project" })),
    ).toHaveCount(1);
  });
});

test.describe("the empty project list", () => {
  test("offers re-checking rather than a consent screen that changes nothing", async ({
    page,
  }) => {
    await injectFaults(page, { projectsSource: "none" });
    await signInBare(page);

    await expect(onlyVisible(page.getByText("No projects to show"))).toBeVisible();

    // The primary action creates one, because the account is reachable and holds nothing.
    // Check again and re-authorizing are both still offered and both demoted: the
    // authorization is intact, and sending the user round it is the loop this page used
    // to be.
    await expect(button(page, /create a project/i)).toBeVisible();
    await expect(button(page, /check again/i)).toBeVisible();
    await expect(
      onlyVisible(page.getByRole("link", { name: /authorize again/i })),
    ).toBeVisible();
    await expect(
      onlyVisible(page.getByRole("link", { name: /open railway/i })),
    ).toBeVisible();
  });

  test("re-checking picks up projects that appeared since the page loaded", async ({
    page,
  }) => {
    await injectFaults(page, { projectsSource: "none" });
    await signInBare(page);
    await expect(onlyVisible(page.getByText("No projects to show"))).toBeVisible();

    await injectFaults(page, { projectsSource: "personal" });
    await button(page, /check again/i).click();

    // Proves the button re-queries Railway rather than replaying a cached render.
    await expect(projectSelect(page)).toContainText("Demo Project");
  });
});

/**
 * The first-run path: a reachable Railway account that holds nothing.
 *
 * `projectsEmpty` rather than `projectsSource: "none"` — the two look identical on screen
 * and are not the same state. That fault makes the sources answer with nothing while the
 * fixture still holds projects; this one empties the account, so a project created here
 * shows up in the very next read, which is the thing worth proving.
 */
test.describe("an account with no projects yet", () => {
  const environmentSelect = (page: import("@playwright/test").Page) =>
    onlyVisible(page.getByRole("combobox", { name: "Environment" }));

  test("creates the first project from the empty state and lands on it", async ({
    page,
  }) => {
    await injectFaults(page, { projectsEmpty: true });
    await signInBare(page);
    await expect(onlyVisible(page.getByText("No projects to show"))).toBeVisible();

    await button(page, /create a project/i).click();
    const dialog = onlyVisible(page.getByRole("dialog"));
    await expect(dialog).toBeVisible();
    // The destination is on screen before anything is typed, and it rests on the account
    // this app created into before the choice existed.
    await expect(dialog.getByRole("combobox", { name: "Where it goes" })).toHaveText(
      "Personal account",
    );
    await dialog.getByLabel("Project name").fill("Client work");
    await dialog.getByRole("button", { name: "Create project" }).click();

    await expect(toast(page, "Created Client work")).toBeVisible();
    // The point of creating it here rather than on railway.com: the dashboard is now
    // pointed at it, with the default environment Railway made alongside it.
    await expect(projectSelect(page)).toContainText("Client work");
    await expect(environmentSelect(page)).toContainText("production");
    await expect(page).toHaveURL(/project=proj_\d+/);
    // The empty state is gone rather than sitting behind the picker.
    await expect(page.getByText("No projects to show")).toHaveCount(0);
  });

  test("keeps the dialog open and says why when the name is refused", async ({
    page,
  }) => {
    await injectFaults(page, { projectsEmpty: true });
    await signInBare(page);

    await button(page, /create a project/i).click();
    const dialog = onlyVisible(page.getByRole("dialog"));
    await dialog.getByLabel("Project name").fill("x".repeat(65));
    await dialog.getByRole("button", { name: "Create project" }).click();

    await expect(dialog.getByRole("alert")).toHaveText(
      "Keep the name under 64 characters",
    );
    // Still open, still holding what was typed: the fix is an edit, not a retype.
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Project name")).toHaveValue("x".repeat(65));
  });

  test("creates the project in the workspace that was chosen", async ({ page }) => {
    await injectFaults(page, { projectsEmpty: true });
    await signInBare(page);

    await button(page, /create a project/i).click();
    const dialog = onlyVisible(page.getByRole("dialog"));
    await dialog.getByLabel("Project name").fill("Client work");
    await chooseOption(page, "Where it goes", "Acme");
    await dialog.getByRole("button", { name: "Create project" }).click();

    await expect(toast(page, "Created Client work")).toBeVisible();

    /*
     * The assertion that the id was actually sent, rather than that a control existed.
     *
     * The fixture files a project with a `workspaceId` under that workspace and keeps it
     * out of the personal list, so this project can only have reached the dashboard
     * through `me.workspaces` — which is the one path that labels a project with the
     * workspace it came from, and therefore the one that groups it here.
     */
    await projectSelect(page).click();
    const listbox = onlyVisible(page.getByRole("listbox"));
    await expect(listbox.getByText("Acme", { exact: true })).toBeVisible();
    await expect(listbox.getByRole("option", { name: "Client work" })).toBeVisible();
  });

  test("keeps the chosen workspace when the name is refused", async ({ page }) => {
    /*
     * React resets a form once its action settles, and Radix answers that reset by putting
     * the select back to what it mounted with — so a refused name used to leave the typed
     * name on screen and quietly move the project back to the personal account. The name
     * surviving is asserted above; this is the half that was silent.
     */
    await injectFaults(page, { projectsEmpty: true });
    await signInBare(page);

    await button(page, /create a project/i).click();
    const dialog = onlyVisible(page.getByRole("dialog"));
    await dialog.getByLabel("Project name").fill("x".repeat(65));
    await chooseOption(page, "Where it goes", "Acme");
    await dialog.getByRole("button", { name: "Create project" }).click();

    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(dialog.getByRole("combobox", { name: "Where it goes" })).toHaveText(
      "Acme",
    );
  });
});

test.describe("creating an environment", () => {
  test("adds one to the selected project and switches to it", async ({ page }) => {
    await signInBare(page);

    await openCreateFromSelect(page, "Environment", /new environment/i);
    const dialog = onlyVisible(page.getByRole("dialog"));
    await dialog.getByLabel("Environment name").fill("qa");
    await dialog.getByRole("button", { name: "Create environment" }).click();

    await expect(toast(page, "Created qa")).toBeVisible();
    await expect(
      onlyVisible(page.getByRole("combobox", { name: "Environment" })),
    ).toContainText("qa");

    // Empty is the contract: skipInitialDeploys means nothing is copied in and nothing
    // is billed until the user spins something up themselves.
    await expect(
      onlyVisible(page.getByText("Nothing running in this environment")),
    ).toBeVisible();
  });
});

test.describe("a project list that could not be read at all", () => {
  test.beforeEach(async ({ page }) => {
    await injectFaults(page, {
      rejectPersonal: true,
      rejectWorkspaces: true,
    });
    await signInBare(page);
  });

  test("does not render controls that cannot work", async ({ page }) => {
    /*
     * The complaint this exists to answer: with the project read failing, the page
     * still drew a Project dropdown that opened an empty popup, an Environment dropdown
     * dimmed for no stated reason, and a "Nothing running in this environment" empty
     * state — none of which had anything to do with what had gone wrong.
     */
    await expect(page.getByRole("combobox")).toHaveCount(0);
    await expect(onlyVisible(page.getByText(/nothing running/i))).toBeHidden();
  });

  /*
   * Scoped to <main>: Next mounts its own empty role="alert" route announcer on the
   * document, so an unscoped query matches two elements and resolves neither.
   */
  const errorBlock = (page: import("@playwright/test").Page) =>
    onlyVisible(page.locator("main").getByRole("alert"));

  test("names the cause and offers the one action that can fix it", async ({
    page,
  }) => {
    const alert = errorBlock(page);

    await expect(alert).toBeVisible();
    // Not a bare reference id. The sentence has to say what went wrong.
    await expect(alert).toContainText(/authoriz/i);
    // Re-authorize, not Retry: retrying a refused permission is what never worked.
    await expect(alert.getByRole("link", { name: /re-authorize/i })).toBeVisible();
    await expect(alert.getByRole("button", { name: /^retry$/i })).toBeHidden();
  });

  test("keeps the action inside the block that reports the failure", async ({
    page,
  }) => {
    // It used to sit on its own line underneath, in the default button colour, reading
    // as an unrelated control.
    await expect(
      errorBlock(page).getByRole("link", { name: /re-authorize/i }),
    ).toBeVisible();
  });
});

/**
 * A mid-session refusal from Railway, at the transport rather than in a field.
 *
 * The `unauthorized` fault was declared in support.ts, the store and the server and used
 * by no spec at all — so this branch, the one where Railway answers HTTP 401 rather than
 * the 200-with-"Not Authorized" shape the other tests use, had never been walked. They
 * are different code paths: one is classified from the status, the other from Railway's
 * prose, and only the second had coverage.
 */
test.describe("a project read Railway refuses outright", () => {
  test.beforeEach(async ({ page }) => {
    // Both project sources are read in parallel, so two faults are consumed per render;
    // a generous count keeps the reload below refused too.
    await injectFaults(page, { unauthorized: 20 });
    await signInBare(page);
  });

  test("offers re-authorization rather than a retry", async ({ page }) => {
    const alert = onlyVisible(page.locator("main").getByRole("alert"));

    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/authoriz/i);
    // The distinction that matters: retrying a credential Railway has rejected is the
    // loop this app used to send people round.
    await expect(alert.getByRole("link", { name: /re-authorize/i })).toBeVisible();
    await expect(alert.getByRole("button", { name: /^retry$/i })).toBeHidden();
  });

  test("draws no controls that cannot work", async ({ page }) => {
    // With no project list there is nothing to pick. The spin-up form is on another
    // route now, and DashboardFrame withholds every tab's content on this branch — so
    // what is asserted here is the picker's absence and the frame's own gate.
    await expect(page.getByRole("combobox")).toHaveCount(0);
    await expect(onlyVisible(page.getByLabel("Project"))).toHaveCount(0);
  });

  test("says nothing about the upstream failure itself", async ({ page }) => {
    // Railway's own wording never reaches the browser — the sentence is this app's, and
    // the reference id is the only thing that joins it to the server log.
    const main = page.locator("main");
    await expect(main).not.toContainText(/Not authorized/);
    await expect(main).toContainText(/[Rr]eference/);
  });
});

/**
 * Changing the selection is not a navigation.
 *
 * use-dashboard-selection.ts used to push a hardcoded `/dashboard`, which was right while
 * that was the only route. It is one of three now, and the literal would have yanked anyone
 * changing project on another tab back to the container list. This is the direct test of
 * the usePathname fix.
 */
test.describe("the selection on other tabs", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("switching project keeps the reader on the provisioning tab", async ({
    page,
  }) => {
    await openNewContainerTab(page);

    await onlyVisible(page.getByRole("combobox", { name: "Project" })).click();
    await onlyVisible(page.getByRole("option", { name: "Second Project" })).click();

    await expect(page).toHaveURL(/\/dashboard\/new\?/);
    await expect(page).toHaveURL(/project=proj_other/);
    await expect(button(page, /spin up container/i)).toBeVisible();
  });

  test("switching project keeps the reader on the billing tab", async ({ page }) => {
    await openBillingTab(page);

    await onlyVisible(page.getByRole("combobox", { name: "Project" })).click();
    await onlyVisible(page.getByRole("option", { name: "Second Project" })).click();

    await expect(page).toHaveURL(/\/dashboard\/billing\?/);
    await expect(page).toHaveURL(/project=proj_other/);
  });
});
