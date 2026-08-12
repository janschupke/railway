import {
  button,
  expect,
  field,
  onlyVisible,
  row,
  signIn,
  spinUp,
  test,
  toast,
} from "./support";

/**
 * What axe cannot see.
 *
 * Automated scans check structure and contrast; they say nothing about whether focus
 * is trapped in a dialog, restored on close, or whether a control is reachable at all
 * without a mouse. Radix is meant to provide this — these specs are what make swapping
 * a native <select> for a custom one defensible.
 */
test.describe("keyboard operation", () => {
  test("signs in without a mouse", async ({ page }) => {
    await page.goto("/");

    await page.keyboard.press("Tab"); // theme toggle
    await page.getByRole("link", { name: /sign in with railway/i }).focus();
    await page.keyboard.press("Enter");

    await page.waitForURL("**/dashboard**");
  });

  test("traps focus in the destroy dialog and restores it on close", async ({
    page,
  }) => {
    await signIn(page);
    await spinUp(page, "cache");

    const trigger = onlyVisible(
      row(page, "cache").getByRole("button", { name: /^destroy$/i }),
    );
    await trigger.focus();
    await page.keyboard.press("Enter");

    const dialog = onlyVisible(page.getByRole("alertdialog"));
    await expect(dialog).toBeVisible();

    // Cycle well past the dialog's control count; focus must never escape it.
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      const inside = await dialog.evaluate((el) => el.contains(document.activeElement));
      expect(inside, `focus escaped the dialog on tab ${i + 1}`).toBe(true);
    }

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // Focus returns to what opened the dialog, not to the top of the document.
    await expect(trigger).toBeFocused();
  });

  test("completes a destroy entirely from the keyboard", async ({ page }) => {
    await signIn(page);
    await spinUp(page, "cache");

    await row(page, "cache")
      .getByRole("button", { name: /^destroy$/i })
      .focus();
    await page.keyboard.press("Enter");

    const dialog = onlyVisible(page.getByRole("alertdialog"));
    await dialog.getByLabel(/type "cache" to confirm/i).focus();
    await page.keyboard.type("cache");

    await dialog.getByRole("button", { name: /destroy permanently/i }).focus();
    await page.keyboard.press("Enter");

    await expect(toast(page, "Destroyed cache")).toBeVisible();
  });

  test("operates the project select with arrows and Enter", async ({ page }) => {
    await signIn(page);

    const select = onlyVisible(page.getByRole("combobox", { name: "Project" }));
    await select.focus();
    await page.keyboard.press("Enter");

    // Radix moves focus into the listbox asynchronously; arrow keys are ignored
    // until it lands, so wait for the highlighted option rather than sleeping.
    await expect(
      onlyVisible(page.getByRole("option", { name: "Demo Project" })),
    ).toBeFocused();

    await page.keyboard.press("ArrowDown");
    await expect(
      onlyVisible(page.getByRole("option", { name: "Second Project" })),
    ).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(/project=proj_other/);
  });

  test("closes the select with Escape without changing the selection", async ({
    page,
  }) => {
    await signIn(page);

    const select = onlyVisible(page.getByRole("combobox", { name: "Project" }));
    await select.focus();
    await page.keyboard.press("Enter");
    await expect(
      onlyVisible(page.getByRole("option", { name: "Second Project" })),
    ).toBeVisible();

    await page.keyboard.press("Escape");

    await expect(
      onlyVisible(page.getByRole("option", { name: "Second Project" })),
    ).toBeHidden();
    await expect(select).toContainText("Demo Project");
  });

  test("treats the preset chips as one tab stop", async ({ page }) => {
    await signIn(page);

    await onlyVisible(page.getByRole("radio", { name: "Redis" })).focus();
    await page.keyboard.press("ArrowRight");
    await expect(onlyVisible(page.getByRole("radio", { name: "Nginx" }))).toBeFocused();

    await page.keyboard.press("Enter");
    await expect(field(page, "Image reference")).toHaveValue("nginx:alpine");

    // One Tab leaves the whole group rather than stepping through each chip.
    await page.keyboard.press("Tab");
    await expect(field(page, "Image reference")).toBeFocused();
  });

  test("expands the log panel from the keyboard", async ({ page }) => {
    await signIn(page);

    const postgres = row(page, "postgres");
    const disclosure = onlyVisible(postgres.getByRole("button", { name: /^postgres/ }));
    await disclosure.focus();
    await page.keyboard.press("Enter");

    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    await expect(postgres.getByRole("log")).toBeVisible();
  });

  test("announces the log region politely", async ({ page }) => {
    // Assertive would interrupt a screen-reader user on every one of hundreds of
    // build lines, which makes the page unusable rather than accessible.
    await signIn(page);
    await spinUp(page, "cache");

    const cache = row(page, "cache");
    await onlyVisible(cache.getByRole("button", { name: /^cache/ })).click();

    await expect(cache.getByRole("log")).toHaveAttribute("aria-live", "polite");
  });

  test("keeps a visible focus indicator on every interactive control", async ({
    page,
  }) => {
    await signIn(page);

    for (const locator of [
      onlyVisible(page.getByRole("combobox", { name: "Project" })),
      onlyVisible(page.getByRole("radio", { name: "Redis" })),
      field(page, "Name"),
      button(page, /spin up container/i),
    ]) {
      await locator.focus();
      const outlineVisible = await locator.evaluate((el) => {
        const style = getComputedStyle(el);
        return style.outlineStyle !== "none" || style.boxShadow !== "none";
      });
      expect(outlineVisible).toBe(true);
    }
  });
});
