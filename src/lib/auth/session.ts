import { EncryptJWT, jwtDecrypt } from "jose";
import { SESSION } from "@/lib/constants";

export const SESSION_COOKIE = "rc_session";
export const PKCE_COOKIE = "rc_pkce";
export const STATE_COOKIE = "rc_state";

export type SessionUser = {
  id: string;
  name?: string;
  email?: string;
  image?: string;
};

export type RailwaySession = {
  user: SessionUser;
  accessToken: string;
  /** Absent when the user declined `offline_access`; the session then dies at expiry. */
  refreshToken?: string;
  /** Epoch seconds. Railway access tokens live one hour. */
  expiresAt: number;
  scope: string;
};

/**
 * HKDF-SHA256 over SESSION_SECRET, via Web Crypto so this module runs unchanged
 * in the Node runtime and in middleware.
 */
async function deriveKey(secret: string): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode("rc-session-v1"),
      info: new TextEncoder().encode("aes-256-gcm"),
    },
    material,
    256,
  );
  return new Uint8Array(bits);
}

/** Encrypt a session into a compact JWE. The Railway tokens never leave the server in plaintext. */
export async function sealSession(
  session: RailwaySession,
  secret: string,
): Promise<string> {
  const key = await deriveKey(secret);
  return new EncryptJWT({ session })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION.MAX_AGE_SECONDS}s`)
    .encrypt(key);
}

/** Returns null for anything unreadable — tampered, expired, or encrypted under an old secret. */
export async function openSession(
  jwe: string | undefined,
  secret: string,
): Promise<RailwaySession | null> {
  if (!jwe) return null;
  try {
    const key = await deriveKey(secret);
    const { payload } = await jwtDecrypt(jwe, key);
    const session = (payload as { session?: RailwaySession }).session;
    if (!session?.accessToken || !session.user?.id) return null;
    return session;
  } catch {
    return null;
  }
}

export function isExpiring(
  session: Pick<RailwaySession, "expiresAt">,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  return session.expiresAt - nowSeconds <= SESSION.REFRESH_SKEW_SECONDS;
}

export function cookieOptions(appUrl: string) {
  return {
    httpOnly: true,
    secure: appUrl.startsWith("https://"),
    sameSite: "lax" as const,
    path: "/",
  };
}
