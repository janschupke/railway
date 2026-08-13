import {
  disclosure,
  dismissWithEscape,
  expect,
  onlyVisible,
  openDestroyDialog,
  setTheme,
  signIn,
  spinUp,
  settled,
  test,
} from "./support";

/**
 * The security posture, checked in a real browser.
 *
 * The Content-Security-Policy is the part that cannot be verified any other way: a
 * policy that is one directive too tight breaks Radix positioning, or the theme script,
 * or the log stream — and none of those failures mention CSP. So the primary test is a
 * violation collector driven across every surface the policy could break, rather than a
 * string comparison against the header.
 */

type ViolationWindow = Window & { __csp?: string[] };

async function collectViolations(page: Parameters<typeof signIn>[0]) {
  await page.addInitScript(() => {
    (window as ViolationWindow).__csp = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as ViolationWindow).__csp?.push(
        `${event.violatedDirective} blocked ${event.blockedURI} (${event.sourceFile}:${event.lineNumber})`,
      );
    });
  });
}

const violations = (page: Parameters<typeof signIn>[0]) =>
  page.evaluate(() => (window as ViolationWindow).__csp ?? []);

test("the policy blocks nothing the app actually does", async ({ page }) => {
  await collectViolations(page);
  await signIn(page);

  /*
   * The theme script is inline and author-written, so React does not nonce it — this
   * asserts the nonce reached it, and does so through the effect rather than the
   * attribute: if the script were blocked, the stored theme would never apply.
   */
  await setTheme(page, "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  // Radix writes inline `style=` onto popper content; a nonce cannot authorize those.
  await onlyVisible(page.getByRole("combobox", { name: "Project" })).click();
  await expect(
    onlyVisible(page.getByRole("option", { name: "Demo Project" })),
  ).toBeVisible();
  await dismissWithEscape(page, onlyVisible(page.getByRole("listbox")));

  // Opening a dialog makes react-remove-scroll inject a <style> element at runtime.
  await spinUp(page, "cache");
  await settled(page);
  const dialog = await openDestroyDialog(page, "cache");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // connect-src 'self' has to allow the same-origin EventSource.
  await disclosure(page, "cache").click();
  await expect(onlyVisible(page.getByRole("log"))).toBeVisible();

  expect(await violations(page)).toEqual([]);
});

test("every response carries the security headers", async ({ page }) => {
  const response = await page.goto("/");
  const headers = response!.headers();

  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["strict-transport-security"]).toContain("max-age=");
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  // Framework fingerprinting, off by config.
  expect(headers["x-powered-by"]).toBeUndefined();
});

test("static assets are protected from content sniffing", async ({ page }) => {
  /*
   * The proxy deliberately does not run for /_next/static — it would pay a JWE decrypt
   * per chunk — so these headers have to come from next.config's headers(). This is the
   * assertion that catches it if they do not.
   */
  await page.goto("/");
  const src = await page
    .locator('script[src^="/_next/static"]')
    .first()
    .getAttribute("src");
  const asset = await page.request.get(src!);

  expect(asset.status()).toBe(200);
  expect(asset.headers()["x-content-type-options"]).toBe("nosniff");
});

test("the stream endpoint refuses a malformed deployment id", async ({ page }) => {
  await signIn(page);

  // Rejected on shape alone, before a session lookup or any upstream work.
  const response = await page.request.get("/api/streams/not%2Fa%2Fdeployment");
  expect(response.status()).toBe(400);
});

test("signing out cannot be triggered from another origin", async ({ page }) => {
  await signIn(page);

  const forged = await page.request.post("/api/auth/logout", {
    headers: { origin: "https://evil.test" },
  });
  expect(forged.status()).toBe(403);

  // …and the session survived it.
  await page.goto("/dashboard");
  await expect(
    onlyVisible(page.getByRole("heading", { name: "Containers" })),
  ).toBeVisible();
});
