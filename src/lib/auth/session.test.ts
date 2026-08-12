import { describe, expect, it } from "vitest";
import { SESSION } from "@/lib/constants";
import { isExpiring, openSession, sealSession, type RailwaySession } from "./session";

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
