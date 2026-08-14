import {
  addVariable,
  alerts,
  button,
  containerRows,
  disclosure,
  expect,
  expectNoA11yViolations,
  field,
  injectFaults,
  onlyVisible,
  openDestroyDialog,
  row,
  searchBox,
  seedServices,
  selectStatus,
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

    test(`the freight yard is decoration, not content (${theme})`, async ({ page }) => {
      /*
       * The canvas carries the page's whole picture and none of its meaning, so it must
       * be absent from the accessibility tree entirely. The way this breaks later is
       * someone adding a `tabindex` or a `role` to it — the first is an
       * aria-hidden-focus violation the scan above would catch, the second is not, and
       * neither is a `role="img"` with a wordless animation behind it.
       */
      await page.goto("/");
      await setTheme(page, theme);

      const canvas = page.locator("main canvas");
      await expect(canvas).toHaveAttribute("aria-hidden", "true");
      await expect(canvas).not.toHaveAttribute("role", /.*/);
      await expect(canvas).not.toHaveAttribute("tabindex", /.*/);
      await expect(page.getByRole("img")).toHaveCount(0);
    });

    test(`landing page with an error banner has no violations (${theme})`, async ({
      page,
    }) => {
      await page.goto("/?error=session_expired");
      await setTheme(page, theme);
      await expect(alerts(page)).toBeVisible();
      await expectNoA11yViolations(page, `landing-error/${theme}`);
    });

    test(`the sign-out notice has no violations (${theme})`, async ({ page }) => {
      /*
       * A different banner tone from the one above, and the only one on this page that
       * carries a link — so it is the contrast pair the error scan cannot reach:
       * anchor text on the `info` surface rather than plain copy on `danger`.
       */
      await page.goto("/?signed_out=1");
      await setTheme(page, theme);
      await expect(
        page.getByRole("link", { name: /railway account settings/i }),
      ).toBeVisible();
      await expectNoA11yViolations(page, `landing-signed-out/${theme}`);
    });

    test(`the 404 has no violations (${theme})`, async ({ page }) => {
      // The surface with no scan until now, and the one that had no landmark at all:
      // Next's built-in 404 renders bare text with no <main> to skip to.
      await page.goto("/definitely-not-a-route");
      await setTheme(page, theme);
      await expect(onlyVisible(page.getByRole("main"))).toBeVisible();
      await expectNoA11yViolations(page, `not-found/${theme}`);
    });

    test(`populated dashboard has no violations (${theme})`, async ({ page }) => {
      await signIn(page);
      await setTheme(page, theme);
      await expect(row(page, "postgres")).toBeVisible();
      await expectNoA11yViolations(page, `dashboard/${theme}`);
    });

    test(`a filtered, paged list has no violations (${theme})`, async ({ page }) => {
      /*
       * Three surfaces the other cases never reach: the removable chip strip the status
       * dropdown writes, two checkboxes in a group, and the back-to-top button floating
       * over the rows. Contrast on a chip is the one most likely to move with a token —
       * it takes its colour from the same state token pair as the badge it filters — and
       * a floating control overlapping an interactive one is something axe can see.
       */
      await signIn(page);
      await seedServices(page, { name: "spun-web", count: 45 });
      await page.reload();
      await setTheme(page, theme);

      await selectStatus(page, "Running");
      await expect(containerRows(page)).toHaveCount(20);
      await containerRows(page).last().scrollIntoViewIfNeeded();
      await expect(button(page, /back to top/i)).toBeVisible();

      await expectNoA11yViolations(page, `dashboard-filtered/${theme}`);
    });

    test(`the no-matches state has no violations (${theme})`, async ({ page }) => {
      await signIn(page);
      await setTheme(page, theme);

      await searchBox(page).fill("nothing-is-called-this");
      await expect(
        onlyVisible(page.getByText("No containers match these filters")),
      ).toBeVisible();

      await expectNoA11yViolations(page, `dashboard-no-matches/${theme}`);
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

    test(`create dialog has no violations (${theme})`, async ({ page }) => {
      // The other dialog, and a different role: `dialog` rather than `alertdialog`, with
      // a labelled text field and a close button the destroy confirmation does not have.
      await signIn(page);
      await setTheme(page, theme);

      await onlyVisible(page.getByRole("button", { name: /new project/i })).click();
      await expect(onlyVisible(page.getByRole("dialog"))).toBeVisible();

      await expectNoA11yViolations(page, `create-dialog/${theme}`);
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
      await disclosure(page, "cache").click();
      await expect(cache.getByRole("log")).toBeVisible();

      await expectNoA11yViolations(page, `log-panel/${theme}`);
    });

    test(`the log pane's search and filters have no violations (${theme})`, async ({
      page,
    }) => {
      /*
       * Scanned with a needle typed and wrapping on, because the pane at rest draws none
       * of what this checks: the <mark> pairs are the one place a highlight can read in
       * one theme and vanish in the other, and the severity chips only exist once the
       * stream has emitted a line carrying a severity.
       */
      await signIn(page);
      await spinUp(page, "cache");
      await setTheme(page, theme);

      const cache = row(page, "cache");
      await disclosure(page, "cache").click();
      await expect(cache.getByRole("log")).toBeVisible();
      await expect(cache.getByRole("toolbar", { name: "Severity" })).toBeVisible();

      await cache
        .getByRole("searchbox", { name: "Search these log lines" })
        .fill("fake");
      await expect(cache.locator("mark").first()).toBeVisible();
      await cache.getByRole("button", { name: "Wrap long lines" }).click();

      await expectNoA11yViolations(page, `log-search/${theme}`);
    });

    test(`a failed row's explanation has no violations (${theme})`, async ({
      page,
    }) => {
      /*
       * A tinted danger surface carrying a danger-weight control — danger on danger is
       * exactly the contrast pair a token change breaks, and it is why the escape hatch
       * in dashboard/page.tsx takes the block's own weight rather than staying ghost.
       */
      await injectFaults(page, { deploymentsFail: true, logPhase: "none" });
      await signIn(page);
      await spinUp(page, "broken");
      await setTheme(page, theme);

      const broken = row(page, "broken");
      await expect(broken.getByText("Failed")).toBeVisible({ timeout: 20_000 });
      await disclosure(page, "broken").click();
      await expect(
        broken.getByRole("link", { name: /open in railway/i }),
      ).toBeVisible();

      await expectNoA11yViolations(page, `failed-row/${theme}`);
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

    test(`the image warning has no violations (${theme})`, async ({ page }) => {
      /*
       * Its own state rather than a variant of the one above, because it is the opposite
       * arrangement: a message in the field's message slot with the control *not* marked
       * invalid, on a signal colour used as plain text rather than on its own tinted fill.
       * The contrast test covers the token pair; this covers what axe sees rendered.
       */
      await signIn(page);
      await setTheme(page, theme);

      const answered = page.waitForResponse((response) =>
        response.url().includes("/api/image-check"),
      );
      await field(page, "Image reference").fill("nonexistent/image:tag");
      await page.keyboard.press("Escape");
      await answered;
      await expect(page.getByRole("status").first()).toBeVisible();

      await expectNoA11yViolations(page, `image-warning/${theme}`);
    });

    test(`the environment editor has no violations (${theme})`, async ({ page }) => {
      /*
       * Populated and in error, because that is the state with the most to get wrong:
       * repeated controls whose labels have to disambiguate their row, a read-only cell
       * inside a fieldset, and a per-row alert. An empty editor asserts almost nothing.
       */
      await signIn(page);
      await setTheme(page, theme);

      await onlyVisible(
        page.getByRole("button", { name: /show preset images/i }),
      ).click();
      await onlyVisible(page.getByRole("option", { name: /^PostgreSQL/ })).click();
      await expect(page.getByRole("listbox")).toHaveCount(0);
      await field(page, "Name").fill("db");
      await addVariable(page, "RAILWAY_TOKEN", "x");
      await button(page, /spin up container/i).click();
      await expect(alerts(page).first()).toBeVisible();

      await expectNoA11yViolations(page, `variables-editor/${theme}`);
    });
  }
});
