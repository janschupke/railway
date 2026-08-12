import {
  alerts,
  button,
  expect,
  expectNoA11yViolations,
  field,
  injectFaults,
  onlyVisible,
  openDestroyDialog,
  row,
  setTheme,
  signIn,
  spinUp,
  test,
} from "./support";

/**
 * WCAG 2.1 AA, checked in both themes.
 *
 * Colour contrast is the check most likely to regress when a token changes, and the
 * light and dark token sets are independent — a violation in one says nothing about
 * the other, so every state is scanned twice.
 */
const THEMES = ["dark", "light"] as const;

test.describe("accessibility", () => {
  for (const theme of THEMES) {
    test(`landing page has no violations (${theme})`, async ({ page }) => {
      await page.goto("/");
      await setTheme(page, theme);
      await expectNoA11yViolations(page, `landing/${theme}`);
    });

    test(`landing page with an error banner has no violations (${theme})`, async ({
      page,
    }) => {
      await page.goto("/?error=session_expired");
      await setTheme(page, theme);
      await expect(alerts(page)).toBeVisible();
      await expectNoA11yViolations(page, `landing-error/${theme}`);
    });

    test(`populated dashboard has no violations (${theme})`, async ({ page }) => {
      await signIn(page);
      await setTheme(page, theme);
      await expect(row(page, "postgres")).toBeVisible();
      await expectNoA11yViolations(page, `dashboard/${theme}`);
    });

    test(`empty dashboard has no violations (${theme})`, async ({ page }) => {
      await signIn(page);
      await onlyVisible(page.getByRole("combobox", { name: "Environment" })).click();
      await onlyVisible(page.getByRole("option", { name: "staging" })).click();
      await setTheme(page, theme);
      await expect(
        onlyVisible(page.getByText("Nothing running in this environment")),
      ).toBeVisible();
      await expectNoA11yViolations(page, `dashboard-empty/${theme}`);
    });

    test(`dashboard with no projects has no violations (${theme})`, async ({
      page,
    }) => {
      /*
       * A surface no scan ever reached until it had a fixture that could produce it —
       * which is the same gap that let it ship telling users to re-authorize when
       * their authorization was fine. Three controls and an external link, on a card,
       * in both themes.
       */
      await injectFaults(page, { projectsSource: "none" });
      await page.goto("/");
      await page.getByRole("link", { name: /sign in with railway/i }).click();
      await page.waitForURL("**/dashboard**");
      await setTheme(page, theme);
      await expect(onlyVisible(page.getByText("No projects to show"))).toBeVisible();
      await expectNoA11yViolations(page, `dashboard-no-projects/${theme}`);
    });

    test(`dashboard mid-load has no violations (${theme})`, async ({ page }) => {
      /*
       * The only automated check that --rc-skeleton survives a real browser and the
       * light/dark cascade. It fits here for a reason: expectNoA11yViolations forces
       * reducedMotion: "reduce", which is exactly the frozen-pulse state the token was
       * chosen for — a skeleton that relied on the animation would be invisible here.
       */
      await signIn(page);
      await setTheme(page, theme);
      await injectFaults(page, { slowMs: 1200 });

      await onlyVisible(page.getByRole("combobox", { name: "Project" })).click();
      await onlyVisible(page.getByRole("option", { name: "Second Project" })).click();
      await expect(
        onlyVisible(page.locator('[data-loading="containers"]')),
      ).toBeVisible();

      await expectNoA11yViolations(page, `dashboard-loading/${theme}`);
      await injectFaults(page, { slowMs: 0 });
    });

    test(`destroy dialog has no violations (${theme})`, async ({ page }) => {
      await signIn(page);
      await spinUp(page, "cache");
      await setTheme(page, theme);

      await openDestroyDialog(page, "cache");

      await expectNoA11yViolations(page, `destroy-dialog/${theme}`);
    });

    test(`expanded log panel has no violations (${theme})`, async ({ page }) => {
      await signIn(page);
      await spinUp(page, "cache");
      await setTheme(page, theme);

      const cache = row(page, "cache");
      await onlyVisible(cache.getByRole("button", { name: /^cache/ })).click();
      await expect(cache.getByRole("log")).toBeVisible();

      await expectNoA11yViolations(page, `log-panel/${theme}`);
    });

    test(`form validation errors have no violations (${theme})`, async ({ page }) => {
      await signIn(page);
      await setTheme(page, theme);

      await field(page, "Image reference").fill("not a valid image");
      // The portalled list covers the submit button while it is open.
      await page.keyboard.press("Escape");
      await field(page, "Name").fill("bad");
      await button(page, /spin up container/i).click();
      await expect(alerts(page).first()).toBeVisible();

      await expectNoA11yViolations(page, `form-errors/${theme}`);
    });
  }
});
