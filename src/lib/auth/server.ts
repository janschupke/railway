import "server-only";

import { cookies } from "next/headers";
import { env } from "@/env";
import { setSubjectId } from "@/lib/log/context";
import { SESSION } from "@/lib/constants";
import {
  cookieOptions,
  isExpiring,
  openSession,
  sealSession,
  sessionCookieName,
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
  const { APP_URL, SESSION_SECRET } = env();
  return openSession(jar.get(sessionCookieName(APP_URL))?.value, SESSION_SECRET);
}

/** Write the session cookie. Only valid inside a Server Action or Route Handler. */
export async function persistSession(session: RailwaySession): Promise<void> {
  const jar = await cookies();
  const { APP_URL, SESSION_SECRET } = env();
  jar.set(sessionCookieName(APP_URL), await sealSession(session, SESSION_SECRET), {
    ...cookieOptions(APP_URL),
    maxAge: SESSION.MAX_AGE_SECONDS,
  });
}

export async function clearSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(sessionCookieName(env().APP_URL));
}

/**
 * Get a usable access token, refreshing and persisting if it is close to expiry.
 *
 * Middleware normally keeps the token fresh, but a request can still land here with a
 * stale token (long-running page open past expiry, middleware skipped for the path).
 * Server Actions and Route Handlers *can* write cookies, so this is the safe fallback.
 */
export async function requireSession(): Promise<RailwaySession> {
  const session = await getSession();
  if (!session) throw new SessionExpiredError("no session");

  /*
   * One place to attach identity to the request's log context. Every authenticated entry
   * point passes through here, so putting it at each of them would be the same call
   * written five times with five chances to forget it.
   */
  setSubjectId(session.user.id);

  if (!isExpiring(session)) return session;

  const refreshed = await refreshSession(session);
  await persistSession(refreshed);
  return refreshed;
}

/** The token alone, for callers that need nothing else. One refresh path, above. */
export async function requireAccessToken(): Promise<string> {
  return (await requireSession()).accessToken;
}

export { SessionExpiredError };
