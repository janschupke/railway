import "server-only";

import { cookies, headers } from "next/headers";
import { env } from "@/env";
import { requireOrigin } from "@/lib/origin";
import { setSubjectId } from "@/lib/log/context";
import { SESSION } from "@/lib/constants";
import {
  cookieOptions,
  openSession,
  sealSession,
  sessionCookieName,
  type RailwaySession,
} from "./session";
import { SessionExpiredError } from "./refresh";

/**
 * The origin this render is being served at, which decides the cookie's name.
 *
 * `headers()` costs nothing that is not already being paid: it opts a route into dynamic
 * rendering exactly as the `cookies()` call beside it already does, so nothing here
 * becomes uncacheable that was cacheable before.
 *
 * `requireOrigin` throws rather than returning null, and this is the one place that is the
 * right shape: a Server Component has no Response to hand back. It is an invariant rather
 * than a branch — every caller sits on a path the proxy matcher covers, and the proxy has
 * already answered 400 for a request whose origin could not be resolved.
 */
async function servedOrigin() {
  return requireOrigin(await headers(), env());
}

/**
 * Read the session as-is. Safe in Server Components.
 *
 * This deliberately does NOT refresh: Server Components cannot write cookies, so a
 * refresh here would rotate the token and then lose it. Proactive refresh happens in the
 * proxy (see src/proxy.ts); this is the read side of that contract.
 */
export async function getSession(): Promise<RailwaySession | null> {
  const [jar, origin] = await Promise.all([cookies(), servedOrigin()]);
  const { SESSION_SECRET } = env();
  return openSession(jar.get(sessionCookieName(origin))?.value, SESSION_SECRET);
}

/**
 * Write the session cookie. Only valid inside a Server Action or Route Handler.
 *
 * The write-side counterpart of `getSession`. Nothing in the app calls it now that the
 * proxy owns refresh — it is the only place that both mints a session and can write —
 * but a handler that ever needs to persist one must go through here rather than reach
 * for `sealSession` and the cookie name itself.
 */
export async function persistSession(session: RailwaySession): Promise<void> {
  const [jar, origin] = await Promise.all([cookies(), servedOrigin()]);
  const { SESSION_SECRET } = env();
  jar.set(sessionCookieName(origin), await sealSession(session, SESSION_SECRET), {
    ...cookieOptions(origin),
    maxAge: SESSION.MAX_AGE_SECONDS,
  });
}

/**
 * Get the session for an authenticated entry point, or refuse the request.
 *
 * This deliberately does NOT refresh. It used to, as a fallback for a request that
 * reached here with a stale token — but the fallback was both unreachable and harmful.
 *
 * Unreachable: every caller sits on a path the proxy matcher covers (the SSE routes and
 * the dashboard's Server Actions, whose POSTs go to the page URL; the matcher excludes
 * only static assets, `api/auth` and `api/health`). So the proxy has already run, already
 * refreshed if the token was expiring, and already written the sealed cookie onto
 * `request.cookies` before it snapshotted the forwarded headers — meaning `getSession()`
 * here reads the fresh session. When the proxy's refresh failed instead, it deleted the
 * cookie from that same jar, and the `!session` throw below is what fires.
 *
 * Harmful: `src/proxy.ts` is compiled into its own chunk graph, so the dedupe map in
 * ./refresh.ts exists twice in one process and the two copies cannot see each other.
 * Next states the rule outright — do not rely on shared modules or globals across that
 * boundary; `src/lib/log/request-scope.ts` already follows it for the request id. A
 * refresh from this side would therefore spend a token the proxy had just rotated, which
 * is the exact failure the dedupe exists to prevent. The proxy is the only refresh
 * writer, and this is the read side of that contract.
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

  /*
   * Expired, not `isExpiring`: a token inside REFRESH_SKEW_SECONDS still works, and
   * refusing there would sign out a user with five good minutes left over a refresh the
   * proxy is about to do on their next request anyway.
   */
  if (session.expiresAt <= Math.floor(Date.now() / 1000)) {
    throw new SessionExpiredError(
      "access token expired and the proxy did not refresh it",
    );
  }

  return session;
}

/** The token alone, for callers that need nothing else. One refresh path, above. */
export async function requireAccessToken(): Promise<string> {
  return (await requireSession()).accessToken;
}

export { SessionExpiredError };
