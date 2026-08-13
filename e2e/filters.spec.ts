import {
  button,
  containerList as list,
  containerRows as rows,
  expect,
  searchBox as search,
  seedServices,
  settled,
  statusOptions,
  signIn,
  test,
} from "./support";

/** The page size the list renders before anything is loaded on demand. */
const PAGE_SIZE = 20;

test.describe("filtering and paging the container list", () => {
  test.beforeEach(async ({ page }) => {
    /*
     * 45 running services plus the seeded postgres: more than two pages, and enough of
     * one name to make a substring search meaningful.
     *
     * Named with the managed prefix, so postgres stays the only container this app did
     * not create — which is what makes the origin filter assertable at all.
     */
    await signIn(page);
    await seedServices(page, { name: "spun-web", count: 45 });
    await page.reload();
    await settled(page);
  });

  test("renders one page and loads the rest on demand", async ({ page }) => {
    await expect(rows(page)).toHaveCount(PAGE_SIZE);
    await expect(page.getByText(/Showing 20 of 46 containers/)).toBeVisible();

    await button(page, /load more/i).click();
    await expect(rows(page)).toHaveCount(40);

    await button(page, /load more/i).click();
    await expect(rows(page)).toHaveCount(46);

    // The end is stated rather than left as an absence of more rows.
    await expect(button(page, /load more/i)).toHaveCount(0);
    await expect(
      page.getByText("That is every container in this environment."),
    ).toBeVisible();
  });

  test("loads the next page when the bottom comes into view", async ({ page }) => {
    await expect(rows(page)).toHaveCount(PAGE_SIZE);

    await rows(page).last().scrollIntoViewIfNeeded();

    // Nothing was clicked. Without the observer the count would sit at 20.
    await expect(rows(page)).toHaveCount(40);
  });

  test("narrows by name without going back to Railway", async ({ page }) => {
    /*
     * The assertion the whole architecture rests on. Filters live in the URL, but they
     * are written with history.replaceState and applied in memory — Railway's project
     * query takes no filter arguments, so a navigation per keystroke would spend two
     * round trips to compute an answer the browser already has.
     */
    let navigations = 0;
    page.on("request", (request) => {
      if (request.headers()["next-router-state-tree"]) navigations += 1;
    });

    await search(page).fill("postgres");

    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText("postgres");
    await expect(page).toHaveURL(/[?&]q=postgres/);
    expect(navigations).toBe(0);
  });

  test("ORs the selected statuses and ANDs them with the search", async ({ page }) => {
    await seedServices(page, { name: "broken", count: 3, status: "FAILED" });
    await seedServices(page, { name: "asleep", count: 2, status: "SLEEPING" });
    await page.reload();
    await settled(page);

    await button(page, /^Status/).click();
    const options = statusOptions(page);

    await options.getByLabel("Failed", { exact: true }).check();
    await expect(page).toHaveURL(/[?&]status=failed/);
    await expect(rows(page)).toHaveCount(3);

    // Both choices in one visit: the popup deliberately survives a tick, because the
    // answer to "is this narrow enough" is the list behind it.
    await options.getByLabel("Sleeping", { exact: true }).check();
    // One param, both members: the URL says OR rather than repeating itself.
    await expect(page).toHaveURL(/[?&]status=failed,sleeping/);
    await expect(rows(page)).toHaveCount(5);

    await page.keyboard.press("Escape");
    await expect(options).toBeHidden();

    await search(page).fill("asleep");
    await expect(rows(page)).toHaveCount(2);

    /*
     * The trigger can only say how many; the chips say which, and each takes off only
     * itself. Removing Failed from a selection of two is the case a count cannot express
     * and the reason the strip exists — and the search is still ANDed underneath it, so
     * the three sleeping-but-not-"asleep" rows stay out.
     */
    await expect(button(page, /^Status/)).toHaveAccessibleName("Status, 2 selected");
    await button(page, "Remove the Failed filter").click();

    await expect(page).toHaveURL(/[?&]status=sleeping(&|$)/);
    await expect(page).toHaveURL(/[?&]q=asleep/);
    await expect(rows(page)).toHaveCount(2);
  });

  test("filters by whether this app created the container", async ({ page }) => {
    // postgres is the only unmanaged service the fixture seeds.
    await page.getByLabel("Not managed here").check();

    await expect(page).toHaveURL(/[?&]owner=external/);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText("postgres");

    await page.getByLabel("Created here").check();
    // Both ticked is the same as neither: an empty constraint, not an empty result.
    await expect(rows(page)).toHaveCount(PAGE_SIZE);
  });

  test("applies a shared link on the first paint", async ({ page }) => {
    await page.goto("/dashboard?q=web-01&status=running");
    await settled(page);

    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText("web-01");
    // The box shows what the link asked for, so the state is legible, not just applied.
    await expect(search(page)).toHaveValue("web-01");
  });

  test("offers a way back when nothing matches", async ({ page }) => {
    await search(page).fill("nothing-is-called-this");

    await expect(list(page)).toHaveCount(0);
    await expect(page.getByText("No containers match these filters")).toBeVisible();

    await button(page, /clear filters/i)
      .first()
      .click();

    await expect(rows(page)).toHaveCount(PAGE_SIZE);
    await expect(page).not.toHaveURL(/[?&]q=/);
    await expect(search(page)).toHaveValue("");
  });

  test("returns to the top of a list it had to scroll", async ({ page }) => {
    const backToTop = button(page, /back to top/i);
    await expect(backToTop).toHaveCount(0);

    await button(page, /load more/i).click();
    await rows(page).last().scrollIntoViewIfNeeded();
    await expect(backToTop).toBeVisible();

    await backToTop.click();

    await expect(page.getByRole("heading", { name: "Containers" })).toBeInViewport();
    // Focus follows, or the next Tab continues from a control that is now off screen.
    await expect(page.getByRole("heading", { name: "Containers" })).toBeFocused();
    await expect(backToTop).toHaveCount(0);
  });
});
