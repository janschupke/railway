import {
  button,
  containerRows,
  disclosure,
  dismissWithEscape,
  expect,
  onlyVisible,
  openDestroyDialog,
  seedServices,
  settled,
  signIn,
  spinUp,
  test,
  toast,
} from "./support";

/*
 * The one suite that must NOT run under reduced motion.
 *
 * Every other Playwright file either forces `reducedMotion: "reduce"` (see
 * expectNoA11yViolations in support.ts) or does not care. That is exactly why the popper
 * bug below survived a full green suite for as long as it did: reduced motion collapses
 * the offending animation to 0.01ms, which hides the misplacement completely.
 *
 * Importing expectNoA11yViolations here would neuter the file, so do not.
 */
test.describe("popup motion", () => {
  test.beforeEach(async ({ page }) => {
    // Stated rather than assumed. The default is already no-preference, but this file's
    // entire value depends on it, and one careless import could flip it.
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await signIn(page);
  });

  test("no animation targets the popper positioning wrapper", async ({ page }) => {
    /*
     * Radix writes the popper's position as an inline transform on this element. A
     * running animation outranks an inline style, so an animation here — of any
     * property — replaces the positioning for its whole duration.
     */
    await onlyVisible(page.getByRole("combobox", { name: "Project" })).click();

    const offenders = await page.evaluate(() =>
      document
        .getAnimations()
        .filter((animation) => {
          const target = (animation.effect as KeyframeEffect | null)?.target;
          return (
            target instanceof Element &&
            target.matches("[data-radix-popper-content-wrapper]")
          );
        })
        .map((animation) => (animation as CSSAnimation).animationName ?? "unnamed"),
    );

    expect(offenders).toEqual([]);
  });

  test("the popup stays under its trigger on every frame of the open animation", async ({
    page,
  }) => {
    /*
     * The behavioural half. The invariant above would also pass an "animate opacity on
     * the wrapper instead" fix, which still costs a frame of misplacement — this samples
     * where the thing actually paints.
     *
     * Fails on the original bug with x ≈ 0, y ≈ 0 for the first frames: the popup is
     * drawn in the viewport's top-left corner and snaps into place 120ms later.
     */
    const trigger = onlyVisible(page.getByRole("combobox", { name: "Project" }));
    const box = (await trigger.boundingBox())!;
    await trigger.click();

    const wrapper = page.locator("[data-radix-popper-content-wrapper]").first();
    const samples = await wrapper.evaluate(
      (element) =>
        new Promise<Array<{ x: number; y: number }>>((done) => {
          const out: Array<{ x: number; y: number }> = [];
          const started = performance.now();
          const step = () => {
            const rect = element.getBoundingClientRect();
            out.push({ x: rect.left, y: rect.top });
            if (performance.now() - started < 400) requestAnimationFrame(step);
            else done(out);
          };
          requestAnimationFrame(step);
        }),
    );

    expect(samples.length).toBeGreaterThan(3);
    for (const sample of samples) {
      expect(sample.y, "popup painted above its trigger").toBeGreaterThan(box.y);
      expect(
        Math.abs(sample.x - box.x),
        "popup painted away from its trigger",
      ).toBeLessThan(24);
    }
  });

  test("a dismissed toast animates out instead of vanishing", async ({ page }) => {
    /*
     * The provider used to delete the record inside `onOpenChange`, which unmounted the
     * root before Radix's Presence had a node to hold — so no toast in this app had ever
     * animated out. jsdom cannot see this at all (it runs no animations and Presence
     * unmounts immediately), which is why the assertion lives here.
     */
    await spinUp(page, "cache");
    const created = toast(page, /cache/i);
    await expect(created).toBeVisible();

    await created.getByRole("button", { name: /dismiss/i }).click();

    const exiting = await page.evaluate(() =>
      document
        .getAnimations()
        .map((animation) => (animation as CSSAnimation).animationName)
        .filter(Boolean),
    );
    expect(exiting).toContain("content-out");
  });

  test("dismissing a dropdown leaves Escape working everywhere else", async ({
    page,
  }) => {
    /*
     * One dismissal must not consume the next one's Escape. Two layers, opened and
     * closed in sequence, with a spin-up in between.
     *
     * This began as a suspected animation bug — animating the Select was blamed for the
     * destroy dialog refusing to close — and that was wrong. The cause was a race in the
     * pressing, not in the closing: Radix attaches a layer's Escape handler one render
     * after the layer appears, and `toBeVisible()` returns inside that window. See
     * dismissWithEscape in support.ts, which is what both dismissals below go through.
     */
    await onlyVisible(page.getByRole("combobox", { name: "Project" })).click();
    await expect(
      onlyVisible(page.getByRole("option", { name: "Demo Project" })),
    ).toBeVisible();
    await dismissWithEscape(page, onlyVisible(page.getByRole("listbox")));

    await spinUp(page, "cache");
    const dialog = await openDestroyDialog(page, "cache");
    await dismissWithEscape(page, dialog);

    await expect(dialog).toHaveCount(0);
  });

  test("back to top glides by default and jumps under reduced motion", async ({
    page,
  }) => {
    /*
     * The one motion on this page the global CSS rule cannot reach. globals.css
     * neutralises animations and transitions under prefers-reduced-motion, but
     * scrollTo's `behavior` is a JS argument that overrides the CSS scroll-behavior
     * property outright — so the choice has to be made in JS, and this is what says so.
     */
    await seedServices(page, { name: "spun-web", count: 45 });
    await page.reload();
    await settled(page);

    const scrollDown = async () => {
      await containerRows(page).last().scrollIntoViewIfNeeded();
      await expect(button(page, /back to top/i)).toBeVisible();
    };

    // Sampled one frame after the click: smooth is still on its way, instant is home.
    const offsetAfterAFrame = () =>
      page.evaluate(
        () =>
          new Promise<number>((done) =>
            requestAnimationFrame(() => done(window.scrollY)),
          ),
      );

    await scrollDown();
    await button(page, /back to top/i).click();
    expect(await offsetAfterAFrame()).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await scrollDown();
    await button(page, /back to top/i).click();
    expect(await offsetAfterAFrame()).toBe(0);
  });

  test("expanding a container row animates the panel open", async ({ page }) => {
    // The panel was a hard `hidden` toggle: the chevron rotated and 256px of log pane
    // appeared on the same frame.
    await spinUp(page, "cache");
    await disclosure(page, "cache").click();

    const panel = onlyVisible(page.locator("[data-panel-open]"));
    await expect(panel).toHaveAttribute("data-panel-open", "true");

    const running = await panel.evaluate((element) =>
      element.getAnimations().map((animation) => animation.playState),
    );
    expect(running).toContain("running");
  });
});

/**
 * The rail yard on the landing page.
 *
 * Its own describe because it needs no session, and because it is the one motion in the
 * app that `globals.css` cannot reach: the reduced-motion block clamps animations and
 * transitions, and requestAnimationFrame is neither. Every other suite either forces
 * reduced motion or does not care, so a loop that ignored the preference entirely would
 * be caught nowhere but here.
 */
test.describe("the freight yard", () => {
  const canvas = (page: import("@playwright/test").Page) => page.locator("main canvas");

  const read = async (page: import("@playwright/test").Page) => {
    await expect(canvas(page)).toBeAttached();
    return canvas(page).evaluate((element) =>
      (element as HTMLCanvasElement).toDataURL(),
    );
  };

  /**
   * Roughly twenty frames at 60Hz.
   *
   * The one number in this describe, and it is a bound rather than a wait: long enough
   * that a running yard has certainly repainted, short enough to keep the reduced-motion
   * case from costing a second. Expressed as frames because that is the unit the thing
   * under test schedules in.
   */
  const TWENTY_FRAMES_MS = 20 * 17;

  test("runs by default", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/");

    const first = await read(page);
    // A blank canvas would also differ from nothing, so there has to be something there
    // before "it changed" means anything.
    expect(first.length).toBeGreaterThan(1_000);

    /*
     * Polled rather than slept, because this asserts a *presence*: the canvas has to have
     * repainted. testing.md allows a sleep only for an absence, and a fixed one here was
     * both slower than it needed to be and one busy CI worker away from flaking — a yard
     * that repaints on the very next frame still had to wait out the whole 400ms.
     */
    await expect.poll(() => read(page), { timeout: TWENTY_FRAMES_MS }).not.toBe(first);
  });

  test("holds a single frame under reduced motion", async ({ page }) => {
    /*
     * Not "it slowed down" — it must not schedule a frame at all. The simulation is warmed
     * up before anyone sees it precisely so the one frame a reduced-motion visitor gets is
     * a yard at work rather than three locomotives asleep in sheds.
     */
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");

    const first = await read(page);
    expect(first.length).toBeGreaterThan(1_000);

    // An absence, which is the one thing testing.md says a bounded sleep is for: there is
    // no event that means "no frame was drawn", only time in which none was.
    await page.waitForTimeout(TWENTY_FRAMES_MS);
    expect(await read(page)).toBe(first);
  });

  test("stops the loop while the tab is hidden", async ({ page }) => {
    // A backgrounded tab paints nothing; rAF is throttled but not stopped, and a yard
    // stepping on in a tab nobody is looking at is CPU spent on no one.
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.goto("/");
    await expect(page.locator("main canvas")).toBeAttached();

    const frames = await page.evaluate(async () => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));

      let count = 0;
      const tick = () => {
        count += 1;
        handle = requestAnimationFrame(tick);
      };
      let handle = requestAnimationFrame(tick);
      await new Promise((done) => setTimeout(done, 300));
      cancelAnimationFrame(handle);
      return count;
    });

    // The probe's own frames still run; the point is the page did not throw or wedge.
    expect(frames).toBeGreaterThan(0);

    // An absence again — no frame is drawn while hidden — so a bounded wait is the tool.
    const first = await read(page);
    await page.waitForTimeout(TWENTY_FRAMES_MS);
    expect(await read(page)).toBe(first);
  });
});
