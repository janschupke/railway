import type { Locator } from "@playwright/test";
import {
  openCreateFromSelect,
  addVariable,
  button,
  containerRows,
  disclosure,
  dismissWithEscape,
  expect,
  field,
  onlyVisible,
  openNewContainerTab,
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

    /*
     * The `…` trigger, which is what the focus restore has to return to now — the destroy
     * trigger it used to return to is a menu item that unmounts the moment the menu closes.
     *
     * That the restore still works is not incidental: closing the menu, waiting a frame and
     * only then opening the dialog is what leaves the trigger as `document.activeElement`
     * when the dialog mounts, so the dialog's own focus scope records it. See `openDialog`
     * in container-actions.tsx.
     */
    const trigger = onlyVisible(
      row(page, "cache").getByRole("button", { name: /^Actions for / }),
    );
    await trigger.focus();
    await page.keyboard.press("Enter");
    await onlyVisible(
      page.getByRole("menu").getByRole("menuitem", { name: /^destroy$/i }),
    ).click();

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

  test("opens the row menu with arrows and dismisses it with Escape", async ({
    page,
  }) => {
    /*
     * The menu is now the only route to every verb on a row, so its own keyboard model is
     * load-bearing rather than a Radix detail. Arrow-key navigation is the reason a menu
     * was the right primitive here — `multi-select.tsx` rejected DropdownMenu for the
     * status filter on exactly that argument: *"its arrow-key model exists because a menu
     * closes when you pick something."*
     *
     * Escape has to leave the row usable, which means focus back on the trigger. A menu
     * that dismissed to nowhere would strand a keyboard user in the middle of a list.
     */
    await signIn(page);
    await spinUp(page, "cache");

    /*
     * Settled first, and this is not politeness about timing.
     *
     * `availableActions` returns nothing while a container is queued or building, so the
     * menu at that moment holds Details and Open in Railway and nothing else — and it grows
     * the lifecycle verbs the instant the row reaches Running. Opening it mid-deploy tests a
     * list that changes underneath the assertion: it failed exactly that way, with the item
     * at index 1 resolving to the Railway link on a menu that had two commands in it.
     *
     * Worth stating as behaviour rather than only as a wait: a menu left open across that
     * transition has its items replaced, and focus goes with them. A person is unlikely to
     * hold one open through a deploy, and the alternative — freezing the commands at the
     * state they were opened at — would offer Stop on a container that had since crashed.
     * The wait is here because this test is about the keyboard model, not about that.
     */
    await expect(row(page, "cache").getByText("Running")).toBeVisible({
      timeout: 20_000,
    });

    const trigger = onlyVisible(
      row(page, "cache").getByRole("button", { name: /^Actions for / }),
    );
    await trigger.focus();
    await page.keyboard.press("Enter");

    const menu = onlyVisible(page.getByRole("menu"));
    await expect(menu).toHaveCSS("pointer-events", "auto");

    /*
     * Enter opens the menu with the first command already focused — a menu focuses its
     * content, which is what separates it from a popover and why arrow keys work at all.
     *
     * Asserted through `toBeFocused` on the item rather than through `data-highlighted`,
     * because focus is the thing a screen reader follows and the attribute is Radix's own
     * bookkeeping. Moving down twice reaches the second command rather than the third:
     * the first ArrowDown is consumed settling the already-focused item, which is Radix's
     * behaviour and not this app's to correct — it is recorded here rather than papered
     * over so a future upgrade that changes it fails loudly.
     */
    await expect(menu.getByRole("menuitem").first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem").nth(1)).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("traps focus in the create dialog and restores it on close", async ({
    page,
  }) => {
    /*
     * The same guarantee as the destroy dialog above, on a different Radix primitive.
     * Worth its own test rather than assumed from that one: the reason destroy imports
     * its body statically is that a dynamic import left nothing in the content at open
     * time and broke the trap, and this dialog is one refactor away from the same fix.
     */
    await signIn(page);

    const trigger = onlyVisible(page.getByRole("combobox", { name: "Project" }));
    const dialog = await openCreateFromSelect(page, "Project", /new project/i);
    await expect(dialog.getByLabel("Project name")).toBeVisible();

    for (let i = 0; i < 10; i++) {
      await page.keyboard.press("Tab");
      const inside = await dialog.evaluate((el) => el.contains(document.activeElement));
      expect(inside, `focus escaped the dialog on tab ${i + 1}`).toBe(true);
    }

    await dismissWithEscape(page, dialog);
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("traps focus in the edit dialog once its variables have landed", async ({
    page,
  }) => {
    /*
     * The third dialog, and the one with a reason of its own to be tested rather than
     * assumed from the two above: its body grows a whole fieldset when
     * `/api/service-variables` answers, so the trap has to hold across a subtree that
     * appears after open. Radix computes the tabbable set at mount, and a spec that tabbed
     * before the fetch landed would prove the trap for a form that is not the one on screen.
     *
     * Edit is a mode of the detail dialog now rather than a dialog of its own, which makes
     * the subtree it grows larger rather than smaller: the whole facts list is replaced by
     * the form. Same test, one keystroke further in.
     */
    await signIn(page);
    await spinUp(page, "db", "PostgreSQL");
    await expect(row(page, "db").getByText("Running")).toBeVisible({ timeout: 20_000 });

    const trigger = onlyVisible(
      row(page, "db").getByRole("button", { name: /^Actions for / }),
    );
    await trigger.focus();
    await page.keyboard.press("Enter");
    await onlyVisible(
      page.getByRole("menu").getByRole("menuitem", { name: /^details$/i }),
    ).click();

    const dialog = onlyVisible(page.getByRole("dialog"));
    await expect(dialog).toBeVisible();

    await onlyVisible(dialog.getByRole("button", { name: /^edit$/i })).click();
    // The editor is what arrives late; tabbing before it lands proves nothing.
    await expect(dialog.getByText("Environment variables")).toBeVisible();

    for (let i = 0; i < 14; i++) {
      await page.keyboard.press("Tab");
      const inside = await dialog.evaluate((el) => el.contains(document.activeElement));
      expect(inside, `focus escaped the dialog on tab ${i + 1}`).toBe(true);
    }

    await dismissWithEscape(page, dialog);
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("creates a project entirely from the keyboard", async ({ page }) => {
    /*
     * Also the guard on the sequencing inside Select's action row, which nothing else
     * would catch. The row closes a modal layer and opens another one a frame later; if
     * those overlap, the dialog's focus scope loses the race to the select's focus
     * restore and the field below is never focused. The Escape at the end is the other
     * half: focus comes back to the trigger only because the select's own restore was
     * allowed to run before the dialog mounted.
     */
    await signIn(page);

    const trigger = onlyVisible(page.getByRole("combobox", { name: "Project" }));
    await trigger.focus();
    await page.keyboard.press("Enter");

    /*
     * Gated on the layer, not merely on the element, for the reason dismissWithEscape
     * documents: Radix portals this popup and hands it its layer a render after it
     * appears, so keystrokes sent before that land on the page behind it.
     */
    const listbox = onlyVisible(page.getByRole("listbox"));
    await expect(listbox).toBeVisible();
    await expect(listbox.getByRole("option", { name: /new project/i })).toBeVisible();

    // End rather than a run of ArrowDown: the create row is always the last one.
    await page.keyboard.press("End");
    /*
     * Gated on the highlight, and this one is not belt-and-braces. Radix moves focus for
     * Home/End inside a `setTimeout`, so an Enter sent in the same tick lands on whichever
     * row was focused before — a project, which selects it and closes the popup with no
     * dialog to show for it. `data-highlighted` is written on focus, so it is the signal
     * that the deferred move has actually happened.
     */
    const createRow = listbox.getByRole("option", { name: /new project/i });
    await expect(createRow).toHaveAttribute("data-highlighted", "");
    await page.keyboard.press("Enter");

    const dialog = onlyVisible(page.getByRole("dialog"));
    await expect(dialog.getByLabel("Project name")).toBeFocused();
    await page.keyboard.type("Keyboard project");
    await page.keyboard.press("Enter");

    await expect(toast(page, "Created Keyboard project")).toBeVisible();
    await expect(trigger).toContainText("Keyboard project");

    const reopened = await openCreateFromSelect(page, "Project", /new project/i);
    await dismissWithEscape(page, reopened);
    await expect(reopened).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("completes a destroy entirely from the keyboard", async ({ page }) => {
    await signIn(page);
    await spinUp(page, "cache");

    await row(page, "cache")
      .getByRole("button", { name: /^Actions for / })
      .focus();
    await page.keyboard.press("Enter");
    /*
     * Arrowed to rather than clicked: this test is about doing the whole thing from the
     * keyboard, and the menu is now part of "the whole thing".
     *
     * `End` rather than arrows, and not to save keystrokes. Destroy is last, and a menu
     * that does not loop — Radix's default, and the right one here — means ArrowUp from the
     * first item goes nowhere. Counting ArrowDowns would encode the item count into this
     * test, so adding a verb to the menu would break a test about destroying a container.
     */
    const menu = onlyVisible(page.getByRole("menu"));
    await expect(menu).toHaveCSS("pointer-events", "auto");
    await page.keyboard.press("End");
    await expect(menu.getByRole("menuitem", { name: /^destroy$/i })).toBeFocused();
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
    await openNewContainerTab(page);
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
    await openNewContainerTab(page);
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
    await openNewContainerTab(page);

    await field(page, "Image reference").focus();
    await page.keyboard.press("Tab");

    await expect(field(page, "Name")).toBeFocused();
  });

  /*
   * The half of the disclosure's keyboard contract jsdom cannot prove: it does not implement
   * the activation behaviour that turns these keys into a click on a `<summary>`, so
   * asserting it there would be asserting against the simulation. Both keys, because both
   * are part of what makes a `<summary>` worth using instead of a div with a handler.
   */
  test("opens and closes the advanced panel with Enter and Space", async ({ page }) => {
    await signIn(page);
    await openNewContainerTab(page);

    const summary = page.getByText("Advanced settings");
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("details[open]")).toHaveCount(1);

    await page.keyboard.press(" ");
    await expect(page.locator("details[open]")).toHaveCount(0);
  });

  test("reaches the advanced panel after the variable editor, not before the name", async ({
    page,
  }) => {
    /*
     * The panel sits last on the form, which is what keeps the Image → Tab → Name order the
     * test above pins. Asserted from the other end: the editor's Add button is the last stop
     * before it.
     */
    await signIn(page);
    await openNewContainerTab(page);

    await button(page, /add variable/i).focus();
    await page.keyboard.press("Tab");

    await expect(page.getByText("Advanced settings")).toBeFocused();
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

  test("moves between the dashboard tabs with Tab, not Arrow", async ({ page }) => {
    /*
     * The assertion that makes ui/tab-nav.tsx's decision a fact rather than a comment.
     * The strip is links with `aria-current`, not `role="tablist"` — so the browser's own
     * sequential navigation moves between them and Enter follows one, where a real tablist
     * would roving-focus on Arrow and swap an in-document panel. The panel here IS a route,
     * which is why the pattern would be a promise the markup cannot keep.
     */
    await signIn(page);

    const containers = onlyVisible(page.getByRole("link", { name: "Containers" }));
    await containers.focus();

    // Arrow does not move focus between them: they are not a roving-tabindex group.
    await page.keyboard.press("ArrowRight");
    await expect(containers).toBeFocused();

    await page.keyboard.press("Tab");
    await expect(
      onlyVisible(page.getByRole("link", { name: "New container" })),
    ).toBeFocused();

    await page.keyboard.press("Enter");
    await page.waitForURL(/\/dashboard\/new(\?|$)/);
    await expect(
      onlyVisible(page.getByRole("link", { name: "New container" })),
    ).toHaveAttribute("aria-current", "page");
  });

  test("keeps a visible focus indicator on every interactive control", async ({
    page,
  }) => {
    await signIn(page);

    /*
     * Two passes, because the controls live on two routes now: the picker and the list's
     * filters are on the container tab, the whole spin-up form is on the provisioning one.
     * Running them as one loop is what a single `signIn` used to buy, and the split costs
     * one navigation rather than any coverage.
     */
    const check = async (controls: Array<[string, Locator]>) => {
      for (const [name, locator] of controls) {
        await locator.focus();
        const outlineVisible = await locator.evaluate((el) => {
          const style = getComputedStyle(el);
          return style.outlineStyle !== "none" || style.boxShadow !== "none";
        });
        // Labelled, because a bare `expect(false).toBe(true)` inside a loop names neither
        // the control that lost its ring nor how far the loop got.
        expect(outlineVisible, name).toBe(true);
      }
    };

    // So the chip's remove control exists to be checked. It is the one focusable thing
    // on this page drawn from scratch rather than from the Button primitive, which makes
    // it the one most able to lose its ring without anyone noticing.
    await selectStatus(page, "Running");

    await check([
      ["containers tab", onlyVisible(page.getByRole("link", { name: "Containers" }))],
      ["billing tab", onlyVisible(page.getByRole("link", { name: "Billing" }))],
      ["project select", onlyVisible(page.getByRole("combobox", { name: "Project" }))],
      ["search", searchBox(page)],
      ["status filter", button(page, /^Status/)],
      ["remove filter chip", button(page, "Remove the Running filter")],
      ["created-here toggle", onlyVisible(page.getByLabel("Created here"))],
    ]);

    await openNewContainerTab(page);
    // So the editor's own controls exist to be checked: a remove button is the next
    // candidate for a control that loses its ring without anyone noticing.
    await addVariable(page, "MY_FLAG", "on");

    /*
     * The modality reset, and it is load-bearing rather than tidy.
     *
     * `focus-ring` is a `:focus-visible` style, and Chromium decides whether a
     * *programmatic* `.focus()` counts as visible from the modality of the last real
     * interaction. `addVariable` ends on a click and a fill, so without this the whole pass
     * below runs in pointer modality and every ring is legitimately absent — which is
     * exactly how this failed. The first pass needs no equivalent because `selectStatus`
     * already ends on an Escape.
     *
     * The two passes used to be one loop for this reason: everything before it was ordered
     * so that a keypress came last. Splitting across routes made that ordering impossible
     * to keep, so the requirement is stated here instead of being carried by an order
     * nobody could see.
     */
    await page.keyboard.press("Escape");

    await check([
      ["image reference", field(page, "Image reference")],
      ["container name", field(page, "Name")],
      ["variable name cell", page.getByLabel("Variable name 1")],
      ["variable value cell", page.getByLabel("Variable value 1")],
      ["remove variable", button(page, "Remove MY_FLAG")],
      ["add variable", button(page, /add variable/i)],
      ["advanced summary", page.getByText("Advanced settings")],
      ["submit", button(page, /spin up container/i)],
    ]);
  });
});
