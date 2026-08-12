import { expect, onlyVisible, signIn, test } from "./support";

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
});
