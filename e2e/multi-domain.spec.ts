import { expect, test } from "./support";

/**
 * The app serves whatever domain the request arrived on, proved against the real
 * `server.js` rather than a mocked request.
 *
 * `http://127.0.0.1:3100` reaches the same listener as the `http://localhost:3100` every
 * other spec uses — the harness binds `::`, the dual-stack wildcard — but it is a
 * different origin, a different cookie jar to the browser, and a different `Host` header
 * on the wire. Both are loopback, so no TLS is involved and the transport rule is
 * satisfied. That makes it the cheapest honest second domain there is.
 *
 * `baseURL` is the localhost one, so every URL here is absolute on purpose.
 */
const SECOND = "http://127.0.0.1:3100";
const FIRST = "http://localhost:3100";

test("conducts the whole sign-in against the domain it started on", async ({
  page,
}) => {
  /*
   * The failure this exists for: with one configured origin, a sign-in started on a
   * custom domain sent the browser to the generated *.up.railway.app one — the
   * redirect_uri named it, so the flow finished somewhere the user had never been.
   */
  const authorize = page.waitForRequest((request) =>
    request.url().includes("/oauth/auth"),
  );

  await page.goto(`${SECOND}/`);
  await page.getByRole("link", { name: /sign in with railway/i }).click();

  const redirectUri = new URL((await authorize).url()).searchParams.get("redirect_uri");
  expect(redirectUri).toBe(`${SECOND}/api/auth/callback`);

  await page.waitForURL(`${SECOND}/dashboard**`);
  await expect(page.getByRole("heading", { name: "Containers" })).toBeVisible();
});

test("keeps a session to the domain it was minted on", async ({ page }) => {
  /*
   * Not a limitation being tolerated — the property being asserted. The session cookie is
   * host-scoped (`__Host-` on https, and the browser's own origin rules everywhere), so a
   * session on one domain is not a session on another and a user signs in per domain.
   */
  await page.goto(`${SECOND}/`);
  await page.getByRole("link", { name: /sign in with railway/i }).click();
  await page.waitForURL(`${SECOND}/dashboard**`);

  await page.goto(`${FIRST}/dashboard`);

  await expect(page).toHaveURL(`${FIRST}/`);
  await expect(page.getByRole("link", { name: /sign in with railway/i })).toBeVisible();
});

test("signs out to the domain it was signed in on", async ({ page }) => {
  await page.goto(`${SECOND}/`);
  await page.getByRole("link", { name: /sign in with railway/i }).click();
  await page.waitForURL(`${SECOND}/dashboard**`);

  await page.getByRole("button", { name: /sign out/i }).click();

  // Both halves: the CSRF check accepted a POST whose Origin is this domain rather than
  // the configured one, and the redirect went home to the same place.
  await expect(page).toHaveURL(`${SECOND}/?signed_out=1`);
});

test("will not be talked onto a domain it does not serve", async ({ page }) => {
  /*
   * The allowlist, which the harness sets to the two loopback origins above. A caller that
   * can reach the container directly can write any X-Forwarded-Host it likes; what it
   * cannot do is make the app conduct a sign-in against it. Asserted through
   * /api/auth/login, whose redirect_uri is a direct readout of the origin the app derived.
   *
   * `x-forwarded-proto: https` is set deliberately, and matters. Without it the request is
   * refused one rule earlier — Next's own server stamps `x-forwarded-proto: http` on an
   * http connection when the header is absent, and a cleartext scheme on a public host is
   * refused before the allowlist is consulted. That is a real refusal, but it is not the
   * one this case is named after.
   */
  const response = await page.request.get(`${FIRST}/api/auth/login`, {
    headers: {
      "x-forwarded-host": "evil.example.com",
      "x-forwarded-proto": "https",
    },
    maxRedirects: 0,
  });

  const location = new URL(response.headers()["location"]!);
  expect(location.searchParams.get("redirect_uri")).toBe(`${FIRST}/api/auth/callback`);
});
