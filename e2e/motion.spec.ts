import {
  button,
  containerRows,
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
    await button(page, /^cache/).click();

    const panel = onlyVisible(page.locator("[data-panel-open]"));
    await expect(panel).toHaveAttribute("data-panel-open", "true");

    const running = await panel.evaluate((element) =>
      element.getAnimations().map((animation) => animation.playState),
    );
    expect(running).toContain("running");
  });
});
