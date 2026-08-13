import {
  button,
  disclosure,
  expect,
  injectFaults,
  onlyVisible,
  openDestroyDialog,
  row,
  settled,
  signIn,
  spinUp,
  test,
} from "./support";

/*
 * Loading states, measured against a genuinely slow Railway rather than a client stub.
 *
 * `slowMs` delays every GraphQL POST at the fixture, so the production code path runs
 * unmodified. A project switch costs 2 × slowMs — listProjects holds the shell, then
 * getProjectContainers is what the skeleton covers — so 1200ms leaves a comfortable
 * window inside Playwright's 10s expect timeout. Every test resets it to 0 before
 * settled(), or the teardown would outlive the test.
 */

const skeleton = (page: Parameters<typeof settled>[0]) =>
  onlyVisible(page.locator('[data-loading="containers"]'));

async function switchToSecondProject(page: Parameters<typeof settled>[0]) {
  await onlyVisible(page.getByRole("combobox", { name: "Project" })).click();
  await onlyVisible(page.getByRole("option", { name: "Second Project" })).click();
}

test("switching project swaps in skeleton rows instead of freezing the old list", async ({
  page,
}) => {
  await signIn(page);
  await expect(row(page, "postgres")).toBeVisible();

  await injectFaults(page, { slowMs: 1200 });
  await switchToSecondProject(page);

  await expect(skeleton(page)).toBeVisible();
  /*
   * The assertion that actually pins the design. React only reveals a fallback for a
   * boundary it is mounting fresh, so the key has to be on <Suspense> itself — key the
   * child instead and this page holds the previous project's rows for the whole fetch,
   * which compiles, renders, and reads identically in review.
   */
  await expect(row(page, "postgres")).toHaveCount(0);

  await injectFaults(page, { slowMs: 0 });
  // Second Project holds no services, so there is no container list to settle on —
  // the skeleton clearing is the signal that the fetch landed.
  await expect(skeleton(page)).toHaveCount(0);
});

test("the picker stays usable while the list loads", async ({ page }) => {
  await signIn(page);
  await injectFaults(page, { slowMs: 1200 });
  await switchToSecondProject(page);

  const projectSelect = onlyVisible(page.getByRole("combobox", { name: "Project" }));
  await expect(skeleton(page)).toBeVisible();
  await expect(projectSelect).toBeEnabled();
  // The shell is not replaced, so focus is still on the control the user committed.
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");

  await injectFaults(page, { slowMs: 0 });
  await expect(skeleton(page)).toHaveCount(0);
});

test("a refresh does not blank the list", async ({ page }) => {
  /*
   * The other half of the keyed-boundary contract: router.refresh() keeps the same key,
   * so React holds the rendered list rather than revealing a fallback. Blanking a list
   * the user is reading, because a background refresh landed, would be worse than the
   * bug this suite was written for.
   */
  await signIn(page);
  await injectFaults(page, { slowMs: 900 });
  await spinUp(page, "cache");

  await expect(row(page, "postgres")).toBeVisible();
  await expect(skeleton(page)).toHaveCount(0);

  await injectFaults(page, { slowMs: 0 });
  await settled(page);
  await expect(row(page, "cache")).toBeVisible();
});

test("spin up keeps reporting while the list refreshes", async ({ page }) => {
  await signIn(page);
  await injectFaults(page, { slowMs: 900 });
  await spinUp(page, "cache");

  // The action has returned and the toast has fired; the wait for the fresh list is
  // what used to be invisible.
  const submit = button(page, /spin up container|updating list/i);
  await expect(submit).toHaveAttribute("aria-busy", "true");
  await expect(submit).toHaveText(/updating list/i);

  await injectFaults(page, { slowMs: 0 });
  await settled(page);
  await expect(submit).not.toHaveAttribute("aria-busy", "true");
  await expect(row(page, "cache")).toBeVisible();
});

test("destroying locks the row's control until the list refreshes", async ({
  page,
}) => {
  await signIn(page);
  await spinUp(page, "doomed");
  await settled(page);
  await expect(row(page, "doomed")).toBeVisible();

  await injectFaults(page, { slowMs: 900 });
  const dialog = await openDestroyDialog(page, "doomed");
  await dialog.getByLabel(/to confirm/i).fill("doomed");
  await dialog.getByRole("button", { name: /destroy permanently/i }).click();

  /*
   * The row survives until the refreshed list lands. Its trigger used to stay live, and
   * a second click hit a service that no longer existed and answered with an error.
   */
  await expect(
    row(page, "doomed").getByRole("button", { name: /destroy|removing/i }),
  ).toHaveAttribute("aria-busy", "true");

  await injectFaults(page, { slowMs: 0 });
  await settled(page);
  await expect(row(page, "doomed")).toHaveCount(0);
});

test("expanding a row never shows an empty panel", async ({ page }) => {
  // LogPane is a dynamic import; without a loading fallback the panel is blank until
  // its chunk arrives.
  await signIn(page);
  await spinUp(page, "logs");
  await settled(page);

  await disclosure(page, "logs").click();

  await expect(onlyVisible(page.getByRole("log"))).toBeVisible();
});

test("the header does not move when the dashboard finishes loading", async ({
  page,
}) => {
  await signIn(page);
  await injectFaults(page, { slowMs: 1200 });

  /*
   * `commit` rather than the default `load`: the route-level loading.tsx is streamed in
   * the first flush and replaced as soon as the page resolves, so waiting for the load
   * event would return after the skeleton had already been swapped out.
   */
  await page.goto("/dashboard", { waitUntil: "commit" });
  const header = page.locator("header").first();
  await expect(onlyVisible(page.locator('main[aria-busy="true"]'))).toBeVisible();
  const loadingBox = await header.boundingBox();

  await injectFaults(page, { slowMs: 0 });
  await settled(page);
  const settledBox = await header.boundingBox();

  /*
   * The header lives in the root layout, above this route's loading boundary, so this is
   * literally the same element before and after — not a placeholder kept pixel-identical
   * to a real bar by hand, which is what it used to be. The assertion now guards the
   * placement decision rather than a copied class string.
   */
  expect(settledBox).toEqual(loadingBox);
});
