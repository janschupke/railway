import type { Locator } from "@playwright/test";
import {
  addVariable,
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
  selectStatus,
  statusOptions,
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
  test("offers a skip link as the very first stop, on every page", async ({ page }) => {
    /*
     * Without it, reaching the content costs five or six stops on every navigation —
     * the brand link, three theme radios, sign out. Axe stays silent because its
     * `bypass` rule is satisfied by the <main> landmark alone, so nothing but this
     * notices if the link is dropped or stops pointing anywhere.
     */
    await page.goto("/");

    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: /skip to content/i });
    await expect(skip).toBeFocused();
    // sr-only until focused: it must not take up space for everyone else.
    await expect(skip).toBeInViewport();

    await page.keyboard.press("Enter");
    await expect(page.locator("main")).toBeFocused();
  });

  test("signs in without a mouse", async ({ page }) => {
    await page.goto("/");

    // Past the skip link, then the brand link the header puts first.
    await page.keyboard.press("Tab");
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
    /*
     * Assertive would interrupt a screen-reader user on every one of hundreds of build
     * lines, which makes the page unusable rather than accessible.
     *
     * Asserted as "is a log region, and is not assertive" rather than on an explicit
     * aria-live. role="log" carries an implicit polite live region, so the attribute
     * was saying nothing the role did not — and the dashboard has enough regions
     * competing without a redundant one.
     */
    await signIn(page);
    await spinUp(page, "cache");

    const cache = row(page, "cache");
    await disclosure(page, "cache").click();

    const log = cache.getByRole("log");
    await expect(log).toBeVisible();
    await expect(log).not.toHaveAttribute("aria-live", "assertive");
  });

  test("opens, ticks and dismisses the status filter without a pointer", async ({
    page,
  }) => {
    /*
     * The filter strip used to be nine toggles behind one Tab stop, walked with the
     * arrow keys. A dropdown replaces that with a single control, and the thing worth
     * proving moves with it: the popup is enterable, a box can be ticked from the
     * keyboard, and Escape both closes it and puts focus back where it started — which
     * is the failure mode of every hand-rolled popup, and the reason this is a Radix
     * Popover rather than a div that toggles.
     */
    await signIn(page);

    const trigger = button(page, /^Status/);
    await trigger.focus();
    await page.keyboard.press("Enter");

    const options = statusOptions(page).getByRole("checkbox");
    await expect(options.first()).toBeFocused();

    await page.keyboard.press("Space");
    await expect(page).toHaveURL(/[?&]status=pending/);
    // The popup survives the tick on purpose: narrowing is iterative, and a popup that
    // closed per box would make the second choice cost a second trip.
    await expect(options.first()).toBeChecked();

    await page.keyboard.press("Escape");
    await expect(statusOptions(page)).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("removes one status from the chip strip with the keyboard", async ({ page }) => {
    // The count on the trigger says how many; only the chips can say which, and taking
    // one off has to be reachable without a pointer like everything else here.
    await signIn(page);
    await selectStatus(page, "Running");
    await selectStatus(page, "Failed");

    const remove = button(page, "Remove the Running filter");
    await remove.focus();
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(/[?&]status=failed(&|$)/);
    await expect(button(page, "Remove the Running filter")).toHaveCount(0);
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

  test("finds a line in the log pane and steps through matches without a mouse", async ({
    page,
  }) => {
    /*
     * The find-bar model, and the reason it is Enter rather than a shortcut: the repo has
     * no global keyboard layer, several panes can be open at once, and capturing the
     * browser's own find would be hostile. So the field is an ordinary tab stop and Enter
     * only does something when there is somewhere to go.
     */
    await signIn(page);
    await spinUp(page, "cache");

    const cache = row(page, "cache");
    await disclosure(page, "cache").click();
    await expect(cache.getByRole("log")).toBeVisible();

    const search = cache.getByRole("searchbox", { name: "Search these log lines" });
    await search.focus();
    await page.keyboard.type("fake-railway");

    /*
     * Waits for a SECOND match before stepping, and that bound is the point.
     *
     * The fixture writes one log line per status transition, 400ms apart, so a pane opened
     * promptly holds exactly one. Pressing Enter there wraps 1 → 1; the second line then
     * arrives and the counter reads "Match 1 of 2" forever, because the keypress it needed
     * has already happened. No amount of retrying the next assertion recovers from that —
     * which is why this failed under the full suite and passed run on its own.
     *
     * Stated as the precondition rather than waited out: stepping between matches needs
     * matches to step between.
     */
    const counter = cache.getByText(/^Match \d+ of \d+$/);
    await expect(counter).toHaveText(/^Match 1 of [2-9]\d*$/);

    await page.keyboard.press("Enter");
    await expect(counter).toHaveText(/^Match 2 of \d+$/);

    await page.keyboard.press("Shift+Enter");
    await expect(counter).toHaveText(/^Match 1 of \d+$/);

    await page.keyboard.press("Escape");
    await expect(search).toHaveValue("");
    await expect(cache.locator("mark")).toHaveCount(0);
  });

  test("reports the wrap toggle's state rather than only drawing it", async ({
    page,
  }) => {
    // A lone two-state control, so aria-pressed on a button rather than a Radix Toggle.
    await signIn(page);
    await spinUp(page, "cache");

    const cache = row(page, "cache");
    await disclosure(page, "cache").click();
    const wrap = cache.getByRole("button", { name: "Wrap long lines" });

    await expect(wrap).toHaveAttribute("aria-pressed", "false");
    await wrap.focus();
    await page.keyboard.press("Enter");
    await expect(wrap).toHaveAttribute("aria-pressed", "true");
  });

  test("keeps a visible focus indicator on every interactive control", async ({
    page,
  }) => {
    await signIn(page);
    // So the chip's remove control exists to be checked. It is the one focusable thing
    // on this page drawn from scratch rather than from the Button primitive, which makes
    // it the one most able to lose its ring without anyone noticing.
    /*
     * So the editor's own controls exist to be checked: a remove button is the next
     * candidate for a control that loses its ring without anyone noticing.
     *
     * Before selectStatus, and that order is load-bearing. `focus-ring` is a
     * :focus-visible style, and Chromium decides whether a *programmatic* .focus() counts
     * as visible from the modality of the last real interaction. selectStatus ends on
     * keyboard.press("Escape"); addVariable ends on a click and a fill. Adding the row
     * afterwards flipped the whole loop to pointer modality, and the first control in it —
     * the project select, which this change does not touch — lost its ring.
     */
    await addVariable(page, "MY_FLAG", "on");
    await selectStatus(page, "Running");

    // Labelled, because a bare `expect(false).toBe(true)` inside a loop names neither the
    // control that lost its ring nor how far the loop got.
    const controls: Array<[string, Locator]> = [
      ["project select", onlyVisible(page.getByRole("combobox", { name: "Project" }))],
      ["image reference", field(page, "Image reference")],
      ["container name", field(page, "Name")],
      ["variable name cell", page.getByLabel("Variable name 1")],
      ["variable value cell", page.getByLabel("Variable value 1")],
      ["remove variable", button(page, "Remove MY_FLAG")],
      ["add variable", button(page, /add variable/i)],
      ["submit", button(page, /spin up container/i)],
      ["search", searchBox(page)],
      ["status filter", button(page, /^Status/)],
      ["remove filter chip", button(page, "Remove the Running filter")],
      ["created-here toggle", onlyVisible(page.getByLabel("Created here"))],
    ];

    for (const [name, locator] of controls) {
      await locator.focus();
      const outlineVisible = await locator.evaluate((el) => {
        const style = getComputedStyle(el);
        return style.outlineStyle !== "none" || style.boxShadow !== "none";
      });
      expect(outlineVisible, name).toBe(true);
    }
  });
});
