import type { Locator } from "@playwright/test";
import { button, expect, onlyVisible, signIn, statusOptions, test } from "./support";

/**
 * The chrome, asserted as an invariant rather than page by page.
 *
 * There used to be no shared shell. The landing page had no bar at all — its theme
 * toggle floated in a bare right-aligned div — the dashboard and its loading state each
 * declared their own copy, the error boundary dropped it and narrowed the column, and
 * the 404 had neither a bar nor a `<main>`. The bar now renders once, in the root
 * layout.
 *
 * This spec is what fails *legibly* if a page reintroduces its own. Two `<header>`
 * landmarks would make e2e/auth.spec.ts's `getByRole("banner")` ambiguous, and
 * Playwright reports that as a strict-mode locator error — which reads like a flake
 * rather than like the design violation it is.
 */
test.describe("the app shell", () => {
  const SIGNED_OUT = [
    ["the landing page", "/"],
    ["the 404", "/definitely-not-a-route"],
  ] as const;

  for (const [name, path] of SIGNED_OUT) {
    test(`${name} has exactly one banner, main and contentinfo`, async ({ page }) => {
      await page.goto(path);

      await expect(onlyVisible(page.getByRole("banner"))).toHaveCount(1);
      await expect(onlyVisible(page.getByRole("main"))).toHaveCount(1);
      await expect(onlyVisible(page.getByRole("contentinfo"))).toHaveCount(1);
      await expect(onlyVisible(page.getByRole("banner"))).toContainText(
        "Railway Freight Loader",
      );
    });

    test(`${name} offers no way to sign out of a session nobody has`, async ({
      page,
    }) => {
      await page.goto(path);

      await expect(page.getByRole("button", { name: /sign out/i })).toHaveCount(0);
      // The rest of the bar is still there, which is the point of rendering it at all.
      await expect(
        onlyVisible(page.getByRole("radiogroup", { name: /theme/i })),
      ).toBeVisible();
    });
  }

  test("the 404 explains itself and offers a way back", async ({ page }) => {
    const response = await page.goto("/definitely-not-a-route");

    expect(response?.status()).toBe(404);
    await expect(onlyVisible(page.getByRole("heading", { level: 1 }))).toBeVisible();
    await expect(page.getByRole("link", { name: /back to the start/i })).toBeVisible();
  });

  test("every control answers the pointer", async ({ page }) => {
    /*
     * Tailwind v4's preflight leaves a button at the browser's default arrow, so this came
     * back as a base rule — and a base rule is exactly the kind of thing that gets deleted
     * by someone who cannot see what depends on it.
     *
     * A real browser, because there is nothing to assert anywhere else: jsdom applies no
     * stylesheets, so the unit suite would agree that a button has no cursor at all. The
     * checkbox's *box* is named separately from its label because that is the pair that was
     * wrong — the row hovered, the control in the middle of it did not.
     */
    await signIn(page);

    const cursorOf = (target: Locator) =>
      target.evaluate((node) => getComputedStyle(node).cursor);

    await expect
      .poll(() => cursorOf(page.getByRole("button", { name: /sign out/i })))
      .toBe("pointer");

    await button(page, /^Status/).click();
    await expect
      .poll(() => cursorOf(statusOptions(page).getByRole("checkbox").first()))
      .toBe("pointer");
  });

  test("the dashboard reuses the same single bar", async ({ page }) => {
    await signIn(page);

    await expect(onlyVisible(page.getByRole("banner"))).toHaveCount(1);
    await expect(onlyVisible(page.getByRole("banner"))).toContainText("Ada Lovelace");
    await expect(page.getByRole("button", { name: /sign out/i })).toHaveCount(1);
  });

  test("the brand takes a signed-in visitor home from a 404", async ({ page }) => {
    /*
     * The reason the mark is a link at all. `/` is the href in both session states —
     * the landing page redirects to the dashboard when a session exists — so this
     * asserts the redirect too, not just the anchor.
     */
    await signIn(page);
    await page.goto("/definitely-not-a-route");

    await onlyVisible(
      page.getByRole("banner").getByRole("link", { name: /railway freight loader/i }),
    ).click();

    await page.waitForURL("**/dashboard**");
    await expect(onlyVisible(page.getByRole("banner"))).toContainText("Ada Lovelace");
  });

  test("a signed-in visitor's 404 points back at the dashboard", async ({ page }) => {
    // `/` would redirect there anyway, so the destination is right either way — the
    // session is read so the label does not tell a signed-in user to sign in.
    await signIn(page);
    await page.goto("/definitely-not-a-route");

    await expect(
      page.getByRole("link", { name: /back to the dashboard/i }),
    ).toBeVisible();
    await expect(onlyVisible(page.getByRole("banner"))).toContainText("Ada Lovelace");
  });
});
