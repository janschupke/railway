import { alerts, expect, fixtureStats, injectFaults, signIn, test } from "./support";

test.describe("authentication", () => {
  test("completes the OAuth round trip and lands on the dashboard", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Railway Freight Loader" }),
    ).toBeVisible();

    await page.getByRole("link", { name: /sign in with railway/i }).click();

    await page.waitForURL("**/dashboard**");
    await expect(page.getByRole("banner")).toContainText("Ada Lovelace");
  });

  test("sends the authorization request with PKCE", async ({ page }) => {
    // The fixture rejects a request without code_challenge_method=S256, so reaching
    // the dashboard at all proves PKCE was used. This asserts it explicitly.
    const authorizeRequest = page.waitForRequest((request) =>
      request.url().includes("/oauth/auth"),
    );

    await page.goto("/");
    await page.getByRole("link", { name: /sign in with railway/i }).click();

    const url = new URL((await authorizeRequest).url());
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("scope")).toContain("project:admin");
    expect(url.searchParams.get("scope")).toContain("workspace:viewer");
    /*
     * Both halves of Railway's condition for issuing a refresh token, on every sign-in.
     * Omitting `prompt` does not skip the consent screen — it produces a grant with no
     * refresh token, which the callback answers by retrying with consent forced, so the
     * screen appears anyway one redirect later. Asserted here because the fixture is the
     * only place that difference is observable before a real account sees it.
     */
    expect(url.searchParams.get("scope")).toContain("offline_access");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  test("carries a refresh token out of the first exchange, so no retry is needed", async ({
    page,
  }) => {
    /*
     * The regression this pair exists for: a sign-in that reaches the dashboard through
     * two authorization round trips looks identical to one that took a single trip.
     * Counting the requests is what tells them apart.
     */
    const authorizations: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/oauth/auth")) authorizations.push(request.url());
    });

    await signIn(page);

    expect(authorizations).toHaveLength(1);
  });

  test("keeps the session across a reload", async ({ page }) => {
    await signIn(page);
    await page.reload();
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test("sends an anonymous visitor away from the dashboard", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL("/");
  });

  test("signs out and clears the session", async ({ page }) => {
    await signIn(page);
    await page.getByRole("button", { name: /sign out/i }).click();

    await expect(page).toHaveURL("/?signed_out=1");
    await page.goto("/dashboard");
    await expect(page).toHaveURL("/");
  });

  test("says the Railway authorization outlived the sign-out", async ({ page }) => {
    await signIn(page);
    await page.getByRole("button", { name: /sign out/i }).click();

    /*
     * The point of the notice: sign-out here ends nothing at Railway, and Railway
     * publishes no endpoint that would let this app end it — so the only way out is a
     * page on Railway, and the user has to be told which one.
     *
     * Located by the link rather than by `getByRole("status")`, which the toast helper
     * in support.ts documents as a trap: Radix renders hidden `role="status"` copies of
     * toast text, and this assertion would match one of those instead of the banner.
     */
    const settings = page.getByRole("link", { name: /railway account settings/i });
    await expect(settings).toBeVisible();
    await expect(settings).toHaveAttribute("href", "https://railway.com/account");
    await expect(settings).toHaveAttribute("target", "_blank");
    await expect(settings).toHaveAttribute("rel", "noreferrer");
  });

  test("refreshes an expiring access token without the user noticing", async ({
    page,
  }) => {
    /*
     * The failure this app most invites: a demo that dies 60 minutes in. The fixture
     * issues a token that is already inside the refresh window, so the very next
     * navigation must rotate it and carry on.
     */
    await injectFaults(page, { accessTokenTtl: 30 });
    await signIn(page);

    // A 30s token is already inside the refresh window, so the first dashboard render
    // rotates it. Measure from there and prove the *next* one rotates again — which
    // also proves the rotated refresh token was persisted rather than dropped.
    const before = (await fixtureStats(page)).refreshToken;
    expect(before).toBeGreaterThan(0);

    await page.reload();

    const after = await fixtureStats(page);
    expect(after.refreshToken).toBeGreaterThan(before);
    expect(after.refreshRejected).toBe(0);
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole("heading", { name: "Containers" })).toBeVisible();
  });

  test("explains a revoked authorization instead of showing a stack trace", async ({
    page,
  }) => {
    await injectFaults(page, { accessTokenTtl: 30 });
    await signIn(page);

    await injectFaults(page, { refreshFails: true });
    await page.reload();

    await expect(page).toHaveURL(/error=session_expired/);
    await expect(alerts(page)).toContainText(/expired/i);
  });

  test("reports a declined authorization in plain language", async ({ page }) => {
    await page.goto("/?error=access_denied");
    await expect(alerts(page)).toContainText("You declined the authorization request.");
  });
});
