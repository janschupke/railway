import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/env";
import { SESSION } from "@/lib/constants";
import {
  SESSION_COOKIE,
  cookieOptions,
  isExpiring,
  openSession,
  sealSession,
} from "@/lib/auth/session";
import { refreshSession } from "@/lib/auth/refresh";

const PROTECTED = ["/dashboard"];

/**
 * Keeps the Railway access token fresh ahead of the render.
 *
 * Server Components can read cookies but not write them, so a token that expires
 * mid-session cannot be repaired during render. The proxy layer (formerly middleware)
 * is the one place that runs before the render and *can* write, so refresh lives here.
 * The refreshed cookie is set on the request as well as the response, so the very
 * render that triggered the refresh already sees the new token rather than waiting for
 * the next navigation.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isProtected = PROTECTED.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );

  const { SESSION_SECRET, APP_URL } = env();
  const raw = request.cookies.get(SESSION_COOKIE)?.value;
  const session = await openSession(raw, SESSION_SECRET);

  if (!session) {
    if (isProtected) return NextResponse.redirect(new URL("/", request.url));
    return NextResponse.next();
  }

  if (!isExpiring(session)) return NextResponse.next();

  try {
    const refreshed = await refreshSession(session);
    const sealed = await sealSession(refreshed, SESSION_SECRET);

    // Set on the request first so this request's render sees the fresh token...
    request.cookies.set(SESSION_COOKIE, sealed);
    const response = NextResponse.next({ request });
    // ...and on the response so the browser keeps it.
    response.cookies.set(SESSION_COOKIE, sealed, {
      ...cookieOptions(APP_URL),
      maxAge: SESSION.MAX_AGE_SECONDS,
    });
    return response;
  } catch {
    // Refresh token spent, revoked, or the app's authorization was withdrawn.
    const target = isProtected
      ? new URL("/?error=session_expired", request.url)
      : request.url;
    const response = isProtected ? NextResponse.redirect(target) : NextResponse.next();
    response.cookies.delete(SESSION_COOKIE);
    return response;
  }
}

export const config = {
  matcher: [
    /*
     * Everything except static assets and the auth routes themselves — the auth
     * routes mint the session and must not be gated by it.
     */
    "/((?!_next/static|_next/image|favicon.ico|api/auth).*)",
  ],
};
