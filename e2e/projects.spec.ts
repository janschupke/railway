import { button, expect, injectFaults, onlyVisible, test } from "./support";

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

  test("still lists projects when Railway rejects the workspace field", async ({
    page,
  }) => {
    // A validation error kills the whole document, so the narrow query is what keeps
    // a schema change from turning an empty list into a broken page.
    await injectFaults(page, { projectsSource: "personal", rejectWorkspaces: true });
    await signInBare(page);

    await expect(projectSelect(page)).toContainText("Demo Project");
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

    // The primary action asks Railway again. Re-authorizing is offered, but demoted:
    // the authorization is intact, and sending the user round it is the loop this
    // page used to be.
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
