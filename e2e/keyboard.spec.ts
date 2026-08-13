import {
  button,
  containerRows,
  disclosure,
  dismissWithEscape,
  expect,
  field,
  onlyVisible,
  row,
  searchBox,
  seedServices,
  settled,
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

    await page.keyboard.press("Tab"); // the brand link, which the header puts first
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
    // The dialog body is a dynamic import; tabbing before it lands proves nothing.
    await expect(dialog.getByLabel(/to confirm/i)).toBeVisible();

    // Cycle well past the dialog's control count; focus must never escape it.
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      const inside = await dialog.evaluate((el) => el.contains(document.activeElement));
      expect(inside, `focus escaped the dialog on tab ${i + 1}`).toBe(true);
    }

    await dismissWithEscape(page, dialog);
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
    await dialog.getByLabel(/type .cache. to confirm/i).focus();
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

    await dismissWithEscape(page, onlyVisible(page.getByRole("listbox")));

    await expect(
      onlyVisible(page.getByRole("option", { name: "Second Project" })),
    ).toBeHidden();
    await expect(select).toContainText("Demo Project");
  });

  test("drives the image list from the keyboard without leaving the field", async ({
    page,
  }) => {
    /*
     * The editable-combobox contract. Focus never moves to the list — the input is the
     * control, and a popup that took focus would make typing-to-filter impossible — so
     * the highlight is carried by aria-activedescendant instead.
     */
    await signIn(page);
    const image = field(page, "Image reference");

    await image.focus();
    await page.keyboard.press("ArrowDown");
    await expect(image).toHaveAttribute("aria-expanded", "true");

    await page.keyboard.press("ArrowDown");
    await expect(image).toBeFocused();
    await expect(image).toHaveAttribute("aria-activedescendant", /.+/);

    await page.keyboard.press("Enter");
    await expect(image).toHaveValue("memcached:1-alpine");
    await expect(image).toHaveAttribute("aria-expanded", "false");
  });

  test("closes the image list on Escape without discarding what was typed", async ({
    page,
  }) => {
    await signIn(page);
    const image = field(page, "Image reference");

    await image.fill("ghcr.io/owner/app");
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.keyboard.press("Escape");

    // Escape closes the list. It does not undo the field, and it must not reach the
    // page behind it — there is an alertdialog on this screen.
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect(image).toHaveValue("ghcr.io/owner/app");
    await expect(image).toBeFocused();
  });

  test("reaches the next field in one Tab from the image control", async ({ page }) => {
    // The chevron is not a tab stop: a second stop on the way to Name, for a shortcut
    // to something ArrowDown already does, is noise.
    await signIn(page);

    await field(page, "Image reference").focus();
    await page.keyboard.press("Tab");

    await expect(field(page, "Name")).toBeFocused();
  });

  test("expands the log panel from the keyboard", async ({ page }) => {
    await signIn(page);

    const postgres = row(page, "postgres");
    const toggle = disclosure(page, "postgres");
    await toggle.focus();
    await page.keyboard.press("Enter");

    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(postgres.getByRole("log")).toBeVisible();
  });

  test("announces the log region politely", async ({ page }) => {
    // Assertive would interrupt a screen-reader user on every one of hundreds of
    // build lines, which makes the page unusable rather than accessible.
    await signIn(page);
    await spinUp(page, "cache");

    const cache = row(page, "cache");
    await disclosure(page, "cache").click();

    await expect(cache.getByRole("log")).toHaveAttribute("aria-live", "polite");
  });

  test("walks the status chips with the arrow keys, one tab stop for nine", async ({
    page,
  }) => {
    /*
     * The reason the chips are a Radix ToggleGroup rather than nine buttons in a div:
     * a roving tabindex means the filter strip costs one Tab, not nine, to pass through.
     */
    await signIn(page);

    const chips = page.getByRole("toolbar", { name: "Status" }).getByRole("button");
    await chips.first().focus();
    await page.keyboard.press("ArrowRight");
    await expect(chips.nth(1)).toBeFocused();

    await page.keyboard.press("Space");
    await expect(chips.nth(1)).toHaveAttribute("aria-pressed", "true");
    await expect(page).toHaveURL(/[?&]status=building/);
  });

  test("pages the list to its end from the keyboard", async ({ page }) => {
    /*
     * An observer-driven infinite list is unreachable by keyboard — there is no way to
     * page without scrolling — which is why Load more renders whenever there is more,
     * not only where IntersectionObserver is missing.
     *
     * Focusing the control scrolls it into view, and that scroll legitimately autoloads
     * a page on the way, so the counts below are not a fixed multiple of the page size.
     * What is asserted is what matters: keys alone reach the end, and focus stays on the
     * control while it exists, because rows are inserted above it.
     */
    await signIn(page);
    await seedServices(page, { name: "spun-web", count: 65 });
    await page.reload();
    await settled(page);

    const loadMore = button(page, /load more/i);
    await loadMore.focus();

    let previous = await containerRows(page).count();
    while ((await loadMore.count()) > 0) {
      await expect(loadMore).toBeFocused();
      await page.keyboard.press("Enter");
      await expect.poll(() => containerRows(page).count()).toBeGreaterThan(previous);
      previous = await containerRows(page).count();
    }

    await expect(containerRows(page)).toHaveCount(66);
    await expect(
      page.getByText("That is every container in this environment."),
    ).toBeVisible();
  });

  test("keeps a visible focus indicator on every interactive control", async ({
    page,
  }) => {
    await signIn(page);

    for (const locator of [
      onlyVisible(page.getByRole("combobox", { name: "Project" })),
      field(page, "Image reference"),
      field(page, "Name"),
      button(page, /spin up container/i),
      searchBox(page),
      page.getByRole("toolbar", { name: "Status" }).getByRole("button").first(),
      onlyVisible(page.getByLabel("Created here")),
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
