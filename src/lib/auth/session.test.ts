import { describe, expect, it } from "vitest";
import {
  isExpiring,
  openSession,
  sealSession,
  REFRESH_SKEW_SECONDS,
  type RailwaySession,
} from "./session";

const SECRET = "a-secret-that-is-at-least-32-characters";

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
    /*
     * Flip a character at the START of the ciphertext. The final base64url character
     * carries only the leftover bits, so changing it can decode to identical bytes and
     * slip past the GCM tag.
     */
    const first = parts[3][0];
    parts[3] = (first === "A" ? "B" : "A") + parts[3].slice(1);
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
    expect(isExpiring({ expiresAt: now + REFRESH_SKEW_SECONDS - 1 }, now)).toBe(true);
  });

  it("is true once already expired", () => {
    expect(isExpiring({ expiresAt: now - 10 }, now)).toBe(true);
  });
});
