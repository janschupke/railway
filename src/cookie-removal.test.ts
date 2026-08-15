import { describe, expect, it } from "vitest";
import { clearCookie, cookieOptions } from "@/lib/auth/session";
import { originFromUrl } from "@/lib/origin";

/** A validated origin, minted the only way there is. See session.test.ts for why. */
const servedAt = (url: string) => originFromUrl(url)!;

/**
 * What `clearCookie` actually writes, asserted by calling it.
 *
 * Next's `delete` emits `name=; Path=/; Expires=1970` and no `Secure`. A cookie whose
 * name carries the `__Host-` prefix — which every cookie this app sets does, on any https
 * origin — is rejected outright unless it is `Secure`, `Path=/` and has no `Domain`. So
 * the browser discards the removal and keeps the cookie.
 *
 * That is why Sign out did not sign anyone out in production: the session cookie
 * survived, the redirect to `/` found it, and `/` sent the user back to the dashboard
 * they had just left. The same silent failure applied to the PKCE, state and consent
 * cookies, so a sign-in's transients outlived it by their full half hour.
 *
 * Neither development nor the end-to-end suite can see it. Both run on `http://localhost`,
 * where `hostCookieName` returns unprefixed names and a plain delete works — which is
 * exactly the shape of defect this is for, and why 130 e2e specs passed across the whole
 * time this was broken.
 *
 * The other half of the rule — that nothing in `src/` calls `delete()` on a jar in the
 * first place — used to be here, as three regexes over every file in the tree. It is
 * `local/no-cookie-jar-delete` now. The move is worth more than tidiness: the alias form
 * needed the binding resolved, and the regex standing in for that recognised only
 * `const|let|var … = await cookies(`, so a destructured handle or one that was never
 * awaited walked straight past it. A rule reads the scope, and says so while you type.
 */
describe("cookie removal", () => {
  it("writes a removal the browser will accept, with the attributes it was set with", () => {
    const written: unknown[] = [];
    clearCookie(
      { set: (name, value, options) => void written.push({ name, value, options }) },
      "__Host-rc_session",
      servedAt("https://example.up.railway.app"),
    );

    expect(written).toEqual([
      {
        name: "__Host-rc_session",
        value: "",
        // Every attribute the prefix requires, plus the expiry that does the removing.
        options: {
          ...cookieOptions(servedAt("https://example.up.railway.app")),
          maxAge: 0,
        },
      },
    ]);
    expect((written[0] as { options: { secure: boolean } }).options.secure).toBe(true);
  });

  it("leaves an http origin's cookie alone about Secure, which it cannot have", () => {
    const written: { secure: boolean }[] = [];
    clearCookie(
      { set: (_n, _v, options) => void written.push(options) },
      "rc_session",
      servedAt("http://localhost:3100"),
    );

    expect(written[0]!.secure).toBe(false);
  });
});
