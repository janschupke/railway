import { EncryptJWT, jwtDecrypt } from "jose";
import { SESSION } from "@/lib/constants";

export const SESSION_COOKIE = "rc_session";
export const PKCE_COOKIE = "rc_pkce";
export const STATE_COOKIE = "rc_state";
/**
 * Marks that the current sign-in already went round with `prompt=consent`, so the
 * callback's no-refresh-token retry can happen exactly once instead of looping.
 */
export const CONSENT_COOKIE = "rc_consent";
/** Query parameter that forces Railway's consent screen. */
export const CONSENT_PARAM = "consent";

/**
 * A cookie's name, which depends on the origin serving it.
 *
 * `__Host-` binds a cookie to exactly one origin: no sibling subdomain can overwrite it
 * and a `Domain` attribute is forbidden, which closes cookie-tossing — an attacker with
 * a write primitive on a related host planting *their* value and having the victim act
 * on it.
 *
 * The prefix also *requires* Secure, which plain-http localhost cannot satisfy. Rather
 * than depend on how each browser resolves that contradiction, the name follows the
 * origin: dev, the E2E fixture on http://localhost:3100 and Lighthouse keep the
 * unprefixed names and behave exactly as before.
 */
function hostCookieName(base: string, appUrl: string): string {
  return appUrl.startsWith("https://") ? `__Host-${base}` : base;
}

/**
 * The session cookie's name.
 *
 * Cookie-tossing against this one plants a whole session, and nothing in the OIDC flow
 * prevents it: state and PKCE guard only the callback, and this path skips the callback
 * entirely.
 */
export function sessionCookieName(appUrl: string): string {
  return hostCookieName(SESSION_COOKIE, appUrl);
}

/**
 * Names for the three cookies that live only for the duration of a sign-in.
 *
 * They were left unprefixed while the session cookie was not, which was an oversight
 * rather than a decision. PKCE and state ARE the callback's CSRF defence: overwrite them
 * from a sibling host and the victim completes the flow against an authorization code
 * the attacker chose, ending up signed into the attacker's Railway account and filing
 * their own containers there. The blast radius is smaller than a planted session and
 * the public suffix list blunts it on railway.app itself, but neither is a reason for
 * the two halves of one flow to be protected differently.
 */
export function transientCookieNames(appUrl: string) {
  return {
    pkce: hostCookieName(PKCE_COOKIE, appUrl),
    state: hostCookieName(STATE_COOKIE, appUrl),
    consent: hostCookieName(CONSENT_COOKIE, appUrl),
  };
}

type SessionUser = {
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
 * Derived keys, by the secret they came from.
 *
 * The derivation is a pure function of SESSION_SECRET, which is fixed for the life of
 * the process, and it was being redone on every seal and every open — four times for
 * one dashboard render (the proxy, the root layout, the shell loader and the container
 * list), plus a pair per SSE connect and one per healthcheck. Keyed on the secret rather
 * than held in a single variable so a test that swaps SESSION_SECRET gets a fresh key
 * instead of a stale one; the Promise is stored rather than the result so concurrent
 * callers share one derivation instead of racing several.
 */
const derivedKeys = new Map<string, Promise<Uint8Array>>();

/**
 * HKDF-SHA256 over SESSION_SECRET, via Web Crypto so this module runs unchanged
 * in the Node runtime and in middleware.
 */
function deriveKey(secret: string): Promise<Uint8Array> {
  const cached = derivedKeys.get(secret);
  if (cached) return cached;
  const derived = deriveKeyUncached(secret);
  derivedKeys.set(secret, derived);
  return derived;
}

async function deriveKeyUncached(secret: string): Promise<Uint8Array> {
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

/**
 * `secure`, `path: "/"` and the absence of `domain` are the three things `__Host-`
 * requires — see sessionCookieName. Adding a `domain` here would make the browser
 * silently reject the cookie in production, which presents as an endless sign-in loop.
 */
export function cookieOptions(appUrl: string) {
  return {
    httpOnly: true,
    secure: appUrl.startsWith("https://"),
    sameSite: "lax" as const,
    path: "/",
  };
}

/** The subset of Next's response cookie jar this needs, so auth stays free of next/server. */
type CookieJar = {
  set: (
    name: string,
    value: string,
    options: ReturnType<typeof cookieOptions> & { maxAge: number },
  ) => void;
};

/**
 * Removes a cookie in a way the browser will actually honour.
 *
 * **Never `response.cookies.delete(name)`.** That emits `name=; Path=/; Expires=1970`
 * with no `Secure`, and a cookie whose name carries the `__Host-` prefix is rejected
 * outright unless it is `Secure`, `Path=/` and has no `Domain`. So the removal is
 * discarded by the browser and the original cookie stays exactly where it was.
 *
 * The failure is invisible in development and in the end-to-end suite, because both run
 * against `http://localhost`, where `hostCookieName` returns an unprefixed name and the
 * plain delete works. In production it meant Sign out did not sign anyone out: the
 * session cookie survived, the redirect to `/` found it, and `/` sent the user straight
 * back to the dashboard they had just asked to leave.
 *
 * Expressed as a `set` with the same options the cookie was written with, which is the
 * only form that cannot drift from them.
 */
export function clearCookie(jar: CookieJar, name: string, appUrl: string): void {
  jar.set(name, "", { ...cookieOptions(appUrl), maxAge: 0 });
}
