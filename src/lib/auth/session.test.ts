import { describe, expect, it, vi } from "vitest";
import { SESSION } from "@/lib/constants";
import { originFromUrl } from "@/lib/origin";
import {
  cookieOptions,
  isExpiring,
  openSession,
  sealSession,
  sessionCookieName,
  transientCookieNames,
  type RailwaySession,
} from "./session";

const SECRET = "a-secret-that-is-at-least-32-characters";

/**
 * These functions take a validated origin, not a string, and lib/origin.ts is the only
 * thing that mints one. Going through it here rather than casting is the point: a test
 * that can fabricate an origin the app would have refused is not exercising the guarantee
 * the type exists to make.
 */
const servedAt = (url: string) => originFromUrl(url)!;

const session: RailwaySession = {
  user: { id: "user_1", name: "Ada", email: "ada@example.com" },
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  scope: "openid project:admin",
};

describe("session sealing", () => {
  it("round-trips a session", async () => {
    const sealed = await sealSession(session, SECRET);
    expect(sealed).not.toContain("access-token");

    const opened = await openSession(sealed, SECRET);
    expect(opened).toEqual(session);
  });

  it("rejects a session sealed under a different secret", async () => {
    const sealed = await sealSession(session, SECRET);
    const opened = await openSession(sealed, "a-different-secret-32-characters-x");
    expect(opened).toBeNull();
  });

  it("rejects tampered ciphertext", async () => {
    const sealed = await sealSession(session, SECRET);
    const parts = sealed.split(".");
    const ciphertext = parts[3];
    // dir + A256GCM always produces header.key.iv.ciphertext.tag, so this is present.
    if (!ciphertext) throw new Error("expected a compact JWE with 5 segments");
    /*
     * Flip a character at the START of the ciphertext. The final base64url character
     * carries only the leftover bits, so changing it can decode to identical bytes and
     * slip past the GCM tag.
     */
    parts[3] = (ciphertext[0] === "A" ? "B" : "A") + ciphertext.slice(1);
    expect(await openSession(parts.join("."), SECRET)).toBeNull();
  });

  it("returns null for a missing cookie", async () => {
    expect(await openSession(undefined, SECRET)).toBeNull();
  });
});

describe("isExpiring", () => {
  const now = 1_000_000;

  it("is false well before expiry", () => {
    expect(isExpiring({ expiresAt: now + 3600 }, now)).toBe(false);
  });

  it("is true inside the refresh skew", () => {
    expect(isExpiring({ expiresAt: now + SESSION.REFRESH_SKEW_SECONDS - 1 }, now)).toBe(
      true,
    );
  });

  it("is true once already expired", () => {
    expect(isExpiring({ expiresAt: now - 10 }, now)).toBe(true);
  });
});

describe("sessionCookieName", () => {
  it("prefixes the cookie with __Host- on an https origin", () => {
    /*
     * __Host- forbids a Domain attribute, so no sibling subdomain can overwrite the
     * session. Without it, an attacker with a cookie-write primitive on a related host
     * plants their own session and the victim acts inside the attacker's account —
     * skipping the OIDC flow entirely, since state and PKCE only guard the callback.
     */
    expect(sessionCookieName(servedAt("https://console.up.railway.app"))).toBe(
      "__Host-rc_session",
    );
  });

  it("keeps the plain name on localhost, where Secure is impossible", () => {
    // The prefix requires Secure. Rather than depend on how each browser resolves that
    // over http://localhost, dev and the e2e fixture keep the unprefixed name.
    expect(sessionCookieName(servedAt("http://localhost:3100"))).toBe("rc_session");
  });
});

describe("key derivation", () => {
  it("derives once per secret rather than once per seal", async () => {
    /*
     * The derivation is a pure function of SESSION_SECRET, which is fixed for the life
     * of the process, and it was redone on every seal and every open: four times for a
     * single dashboard render — the proxy, the root layout, the shell loader and the
     * container list — plus a pair per SSE connect.
     */
    const secret = "a-secret-used-only-by-this-test-32ch";
    const deriveBits = vi.spyOn(crypto.subtle, "deriveBits");

    try {
      const sealed = await sealSession(session, secret);
      await openSession(sealed, secret);
      await sealSession(session, secret);

      expect(deriveBits).toHaveBeenCalledTimes(1);
    } finally {
      deriveBits.mockRestore();
    }
  });

  it("keys the cache on the secret, so a rotated secret is not served a stale key", async () => {
    const a = "secret-number-one-at-least-32-characters";
    const b = "secret-number-two-at-least-32-characters";

    const sealed = await sealSession(session, a);
    // Would round-trip if the derivation were memoised in a single variable.
    expect(await openSession(sealed, b)).toBeNull();
    expect(await openSession(sealed, a)).toEqual(session);
  });
});

describe("transientCookieNames", () => {
  it("gives the sign-in cookies the same protection as the session", () => {
    /*
     * PKCE and state ARE the callback's CSRF defence, and they were left unprefixed
     * while the cookie they exist to protect was not. Overwrite them from a sibling
     * host and the victim completes the flow against an authorization code the attacker
     * chose — signed into the attacker's Railway account, filing their own containers
     * there. Smaller blast radius than a planted session, but not a reason for the two
     * halves of one flow to be protected differently.
     */
    expect(transientCookieNames(servedAt("https://console.up.railway.app"))).toEqual({
      pkce: "__Host-rc_pkce",
      state: "__Host-rc_state",
      consent: "__Host-rc_consent",
    });
  });

  it("keeps the plain names on localhost, exactly as the session cookie does", () => {
    expect(transientCookieNames(servedAt("http://localhost:3100"))).toEqual({
      pkce: "rc_pkce",
      state: "rc_state",
      consent: "rc_consent",
    });
  });
});

describe("cookieOptions", () => {
  it("meets every __Host- requirement on an https origin", () => {
    const options = cookieOptions(servedAt("https://console.up.railway.app"));

    expect(options.secure).toBe(true);
    expect(options.path).toBe("/");
    // A `domain` would make the browser silently reject the prefixed cookie, which
    // presents as an endless sign-in loop rather than as an error.
    expect(Object.keys(options)).not.toContain("domain");
  });

  it("drops Secure on http, so the local session still works", () => {
    expect(cookieOptions(servedAt("http://localhost:3000")).secure).toBe(false);
  });
});
