import {
  createServiceOutOfBand,
  expect,
  fixtureStats,
  row,
  setTabVisibility,
  signIn,
  spinUp,
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

    /*
     * Two assertions, and the server-side one is the real claim.
     *
     * The browser opening no connection is necessary but not sufficient: the cost this
     * feature promises to avoid is *Railway requests*, and those are issued by the poll
     * loop behind a connection that may already be open. Counting Project operations at
     * the fixture is the only place that distinction is visible — a held SSE response
     * never finishes, so nothing on the browser side reports the polling behind it.
     *
     * This replaced a flat four-second wait. The window is still bounded, because
     * proving an absence needs one, but it is now derived from the interval being tested
     * rather than picked to be comfortably larger than it, and a regression shows up as
     * "the server answered N queries" instead of "a connection appeared".
     */
    const before = (await fixtureStats(page)).operations.Project ?? 0;
    const pollMs = Number(process.env.WATCH_POLL_MS ?? 1_000);
    await page.waitForTimeout(pollMs * 2);

    expect(opened, "a hidden tab opened a watch connection").toBe(0);
    const during = (await fixtureStats(page)).operations.Project ?? 0;
    expect(during, "a hidden tab polled Railway").toBe(before);

    await setTabVisibility(page, "visible");
    await expect.poll(() => opened).toBeGreaterThan(0);
    // …and the polling resumes, which is what makes the assertion above meaningful
    // rather than a test of a watcher that had simply died.
    await expect
      .poll(async () => (await fixtureStats(page)).operations.Project ?? 0)
      .toBeGreaterThan(during);
  });

  test("keeps the usage readouts fresh on a project that is not changing", async ({
    page,
  }) => {
    /*
     * The second reason the watcher sends a bit. Metrics are read on the render rather
     * than polled, so on a project where nothing changes the readouts would sit at
     * whatever they were when the page loaded — which is most of the time, and is exactly
     * the case the feature exists for.
     *
     * Counted at the fixture, on the ProjectMetrics operation, for the reason the hidden-tab
     * spec above states: the nudge causes an RSC render, and nothing on the browser side
     * distinguishes that from any other one.
     */
    await spinUp(page, "cache");
    await expect(row(page, "cache").getByText("Running")).toBeVisible({
      timeout: 20_000,
    });

    const before = (await fixtureStats(page)).operations.ProjectMetrics ?? 0;
    const staleMs = Number(process.env.METRICS_POLL_MS ?? 2_000);

    // Derived from the interval being tested, not a round number that felt safe — the
    // habit that kept the watcher spec green while WATCH_POLL_MS was being ignored.
    await expect
      .poll(async () => (await fixtureStats(page)).operations.ProjectMetrics ?? 0, {
        timeout: staleMs * 2,
      })
      .toBeGreaterThan(before);
  });

  test("does not nudge an environment with nothing running", async ({ page }) => {
    /*
     * Why the staleness clock is on the server rather than in the hook. An environment with
     * nothing running has no readouts that can go stale, so a nudge there would spend four
     * Railway requests to re-render the same nothing. A setInterval in the browser has no
     * way to know that; the poll loop does, because it has just read the container list.
     *
     * `staging` is seeded empty, so the watcher is watching and there is genuinely nothing
     * to be stale about. The default `production` holds a postgres parked at SUCCESS, which
     * would have made this pass for the wrong reason.
     */
    await page.goto("/dashboard?project=proj_demo&environment=env_staging");
    await expect(page.getByText(/nothing running in this environment/i)).toBeVisible();

    const before = (await fixtureStats(page)).operations.ProjectMetrics ?? 0;
    const staleMs = Number(process.env.METRICS_POLL_MS ?? 2_000);
    await page.waitForTimeout(staleMs * 1.5);

    expect(
      (await fixtureStats(page)).operations.ProjectMetrics ?? 0,
      "an idle environment was nudged anyway",
    ).toBe(before);
  });
});
