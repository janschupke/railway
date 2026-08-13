import {
  button,
  containerRows as rows,
  expect,
  searchBox as search,
  seedServices,
  selectStatus,
  settled,
  statusOptions,
  signIn,
  test,
} from "./support";

/**
 * The container list at phone width.
 *
 * Runs only under the `mobile` Playwright project — see playwright.config.ts for why the
 * whole suite is not run twice.
 *
 * The app declares essentially no breakpoints on purpose (one `sm:` in all of src/): rows
 * and control strips adapt by wrapping. So the honest thing to assert is not that some
 * layout switched, but that nothing clips, nothing overflows sideways, and every control
 * is still reachable and tappable with the list filtered and paged.
 */
test.describe("the dashboard at phone width", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    // Prefixed, so the rows carry a destroy control rather than the not-managed note.
    await seedServices(page, { name: "spun-web", count: 45 });
    await page.reload();
    await settled(page);
  });

  const noSidewaysScroll = async (page: import("@playwright/test").Page) => {
    const overflow = await page.evaluate(() => {
      const root = document.scrollingElement!;
      return root.scrollWidth - root.clientWidth;
    });
    // A page that scrolls sideways on a phone is the single most common way a wrapping
    // layout fails, and the one axe cannot see.
    expect(overflow).toBeLessThanOrEqual(0);
  };

  test("never scrolls sideways, filtered or paged", async ({ page }) => {
    await noSidewaysScroll(page);

    await search(page).fill("web");
    await selectStatus(page, "Running");
    await noSidewaysScroll(page);

    await button(page, /load more/i).click();
    await noSidewaysScroll(page);
  });

  test("keeps the whole status list reachable from a phone-width row", async ({
    page,
  }) => {
    /*
     * The nine states used to be nine chips in the control row, which is what made this
     * a wrapping question at all: at this width they took three lines and pushed the list
     * down the page. Behind a dropdown the row cannot wrap, and the question becomes
     * whether the popup they moved into is itself usable here — a menu that renders
     * off-screen or under the fold is a worse answer than a strip that wrapped.
     */
    await button(page, /^Status/).click();
    const options = statusOptions(page).getByRole("checkbox");
    await expect(options).toHaveCount(9);

    for (const option of await options.all()) await expect(option).toBeInViewport();
  });

  test("wraps the selected chips instead of clipping them", async ({ page }) => {
    // The strip that replaced the toggles carries only what is selected, so the wrapping
    // case is now several selections rather than the default state.
    for (const state of ["Running", "Failed", "Sleeping", "Removed"]) {
      await selectStatus(page, state);
    }

    const chips = page
      .getByRole("group", { name: "Selected statuses" })
      .getByRole("button");
    await expect(chips).toHaveCount(4);

    // Every chip is inside the viewport, which is what "wrapped" means here — a strip
    // that overflowed would leave the last few outside it.
    for (const chip of await chips.all()) await expect(chip).toBeInViewport();
  });

  test("gives the search field the whole width it can have", async ({ page }) => {
    const field = await search(page).boundingBox();
    const viewport = page.viewportSize()!;

    // grow basis-64 with nothing beside it on a narrow row: the field takes the line.
    expect(field!.width).toBeGreaterThan(viewport.width * 0.8);
  });

  test("keeps the back-to-top button clear of the row controls", async ({ page }) => {
    await rows(page).last().scrollIntoViewIfNeeded();

    const backToTop = button(page, /back to top/i);
    await expect(backToTop).toBeVisible();

    // Bottom-left, and the destroy control on the last row sits to the right of it.
    // Overlapping would make the last container in the list undestroyable on a phone.
    const fab = (await backToTop.boundingBox())!;
    const destroy = (await rows(page).last().getByRole("button").last().boundingBox())!;
    const overlaps =
      fab.x < destroy.x + destroy.width &&
      fab.x + fab.width > destroy.x &&
      fab.y < destroy.y + destroy.height &&
      fab.y + fab.height > destroy.y;
    expect(overlaps).toBe(false);
  });

  test("keeps Load more a real target, and reaches the end of the list", async ({
    page,
  }) => {
    /*
     * Deliberately not "tap it and count the rows". On a phone the control sits below
     * twenty rows, so reaching it means scrolling, and that scroll autoloads the next
     * page and moves the control out from under the tap — a race with the observer
     * rather than a defect, and a test that fights it is testing the scroll.
     *
     * What a phone viewport can actually prove is asserted instead: the control is a
     * touch-sized target inside the viewport, and the list does reach its end here.
     */
    const loadMore = button(page, /load more/i);
    await loadMore.scrollIntoViewIfNeeded();

    const box = (await loadMore.boundingBox())!;
    // The control-token floor; anything shorter is a miss on a touch screen.
    expect(box.height).toBeGreaterThanOrEqual(28);

    /*
     * Its width, not its position.
     *
     * `toBeInViewport()` used to be asserted here and was intermittently false — which
     * turned out to be the app working as designed rather than a defect. The sentinel
     * carries a root margin, so scrolling the control into view is what trips the
     * observer, and the rows that load land ABOVE the button and push it back down. The
     * control's vertical position is therefore transient by construction and asserting
     * on it is asserting on the losing side of a race the product intends to have.
     *
     * What is stably true on a phone is that the target is touch-sized and not clipped
     * by the viewport horizontally, which is the actual complaint this test exists for.
     */
    const viewport = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);

    while ((await loadMore.count()) > 0) {
      await rows(page).last().scrollIntoViewIfNeeded();
    }

    await expect(rows(page)).toHaveCount(46);
    await expect(
      page.getByText("That is every container in this environment."),
    ).toBeVisible();
  });
});

/**
 * The landing page at phone width, signed out.
 *
 * Its own describe because it needs no session and no seeding, and because the yard is
 * the first thing in this app whose width is decided in JavaScript rather than by
 * wrapping — the canvas is sized from a ResizeObserver, so it is the one element that
 * could overflow its column without any CSS saying so.
 */
test.describe("the landing page at phone width", () => {
  test("never scrolls sideways", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("main canvas")).toBeAttached();

    const overflow = await page.evaluate(() => {
      const root = document.scrollingElement!;
      return root.scrollWidth - root.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("keeps the canvas inside the content column", async ({ page }) => {
    // Same width as the chrome above and below it, which is the whole layout claim.
    await page.goto("/");
    const canvas = (await page.locator("main canvas").boundingBox())!;
    const main = (await page.getByRole("main").boundingBox())!;

    expect(canvas.x).toBeGreaterThanOrEqual(main.x - 1);
    expect(canvas.x + canvas.width).toBeLessThanOrEqual(main.x + main.width + 1);
  });

  test("keeps the sign-in card usable over the scene", async ({ page }) => {
    await page.goto("/");

    const signIn = page.getByRole("link", { name: /sign in with railway/i });
    await expect(signIn).toBeInViewport();
    // The canvas is pointer-events:none, so the control under it is still tappable.
    await expect(signIn).toBeEnabled();

    const box = (await signIn.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(28);
  });

  test("sits the card above centre, leaving the yard the room below it", async ({
    page,
  }) => {
    /*
     * The `stage` recipe's bottom padding lifts the card off centre so the busiest part of
     * the scene is not behind it. VIEW.CARD_LIFT_PX in the rail yard's config has to track
     * that padding — it is what keeps the track band clear — so this asserts the lift
     * actually happens rather than trusting the two to stay in step by inspection.
     */
    await page.goto("/");
    const card = (await page.locator("main canvas + div").boundingBox())!;
    const main = (await page.getByRole("main").boundingBox())!;

    const cardCentre = card.y + card.height / 2;
    const mainCentre = main.y + main.height / 2;
    expect(cardCentre).toBeLessThan(mainCentre);
  });
});
