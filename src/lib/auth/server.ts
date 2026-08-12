import "server-only";

import { cookies } from "next/headers";
import { env } from "@/env";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  cookieOptions,
  isExpiring,
  openSession,
  sealSession,
  type RailwaySession,
} from "./session";
import { SessionExpiredError, refreshSession } from "./refresh";

/**
 * Read the session as-is. Safe in Server Components.
 *
 * This deliberately does NOT refresh: Server Components cannot write cookies, so a
 * refresh here would rotate the token and then lose it. Proactive refresh happens in
 * middleware (see src/middleware.ts); this is the read side of that contract.
 */
export async function getSession(): Promise<RailwaySession | null> {
  const jar = await cookies();
  return openSession(jar.get(SESSION_COOKIE)?.value, env().SESSION_SECRET);
}

/** Write the session cookie. Only valid inside a Server Action or Route Handler. */
export async function persistSession(session: RailwaySession): Promise<void> {
  const jar = await cookies();
  const { APP_URL, SESSION_SECRET } = env();
  jar.set(SESSION_COOKIE, await sealSession(session, SESSION_SECRET), {
    ...cookieOptions(APP_URL),
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export async function clearSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}

/**
 * Get a usable access token, refreshing and persisting if it is close to expiry.
 *
 * Middleware normally keeps the token fresh, but a request can still land here with a
 * stale token (long-running page open past expiry, middleware skipped for the path).
 * Server Actions and Route Handlers *can* write cookies, so this is the safe fallback.
 */
export async function requireAccessToken(): Promise<string> {
  const session = await getSession();
  if (!session) throw new SessionExpiredError("no session");

  if (!isExpiring(session)) return session.accessToken;

  const refreshed = await refreshSession(session);
  await persistSession(refreshed);
  return refreshed.accessToken;
}

export { SessionExpiredError };
