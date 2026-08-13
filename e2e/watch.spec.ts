import {
  createServiceOutOfBand,
  expect,
  row,
  setTabVisibility,
  signIn,
  test,
} from "./support";

/**
 * The dashboard notices changes it did not make.
 *
 * Railway publishes log subscriptions and no project, service or deployment-status
 * subscription, so there is nothing upstream to forward — closing this loop means
 * polling, and the only question is who does it. The server does, once per interval per
 * *visible* tab, and tells the browser a single bit.
 *
 * The interval is WATCH_POLL_MS, set low for this suite (playwright.config.ts) so a spec
 * can observe a change without waiting out a production tick.
 */
test.describe("the project watcher", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("shows a service created in Railway, with no user interaction", async ({
    page,
  }) => {
    // Created behind the app's back, exactly as Railway's own dashboard would. Before
    // this existed the row appeared only when someone pressed Refresh or navigated.
    await createServiceOutOfBand(page, "out-of-band");

    /*
     * No timeout override: the suite's interval is one second, so the config's ten is
     * ample. It used to be 20s, which was wide enough to absorb a full *production* tick
     * — and that is the only reason this spec stayed green while WATCH_POLL_MS was
     * ignored by env() and the real interval was 15s. A budget loose enough to hide the
     * bug it exists to catch is not a budget.
     */
    await expect(row(page, "out-of-band")).toBeVisible();
  });

  test("holds no connection while the tab is hidden", async ({ page }) => {
    /*
     * The reason this is affordable at all: a dashboard left open in a background tab
     * costs no connection and no Railway requests, and catches up with one refresh on
     * the way back.
     *
     * Counted at the network layer, not through `performance.getEntriesByType`: a
     * resource entry is only recorded when the request *finishes*, and a held SSE stream
     * never does, so the timeline shows nothing at all while one is open.
     */
    // Counted from the hide onwards. The connection opened during sign-in predates any
    // listener this test could attach, and — being held open — issues nothing further.
    await setTabVisibility(page, "hidden");

    let opened = 0;
    page.on("request", (request) => {
      if (request.url().includes("/api/watch/")) opened += 1;
    });

    // Comfortably more than the suite's one-second poll interval.
    await page.waitForTimeout(4_000);
    expect(opened, "a hidden tab opened a watch connection").toBe(0);

    await setTabVisibility(page, "visible");
    await expect.poll(() => opened).toBeGreaterThan(0);
  });
});
