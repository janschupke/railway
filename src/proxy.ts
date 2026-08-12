import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/env";
import { SESSION } from "@/lib/constants";
import {
  cookieOptions,
  isExpiring,
  openSession,
  sealSession,
  sessionCookieName,
} from "@/lib/auth/session";
import { refreshSession } from "@/lib/auth/refresh";
import { contentSecurityPolicy, generateNonce } from "@/lib/security-headers";

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
  const cookieName = sessionCookieName(APP_URL);

  /*
   * The nonce has to reach two places: Next's own injected inline scripts, and the
   * theme script in layout.tsx.
   *
   * Next reads it off the *request* CSP header — app-render.js parses the header with
   * getScriptNonceFromHeader and stamps the value onto every script it injects — so
   * setting it on `request.headers` is not a workaround, it is the documented channel.
   * x-nonce rides along for layout.tsx to read via headers().
   *
   * Two footguns, both load-bearing: the header set must be built from
   * `new Headers(request.headers)`, because Next drops every request header absent from
   * the override list; and no directive may be named such that it sorts before
   * `script-src` under a `startsWith` scan — which is why there is no `script-src-elem`.
   */
  const nonce = generateNonce();
  const csp = contentSecurityPolicy(nonce, {
    https: APP_URL.startsWith("https://"),
    dev: process.env.NODE_ENV !== "production",
  });

  /*
   * Snapshotted at call time, not once up front: the refresh branch mutates
   * request.cookies first, and that mutation has to be in the headers this forwards.
   */
  const forwarded = () => {
    const headers = new Headers(request.headers);
    headers.set("content-security-policy", csp);
    headers.set("x-nonce", nonce);
    return headers;
  };

  const proceed = () => NextResponse.next({ request: { headers: forwarded() } });

  const withCsp = <T extends NextResponse>(response: T): T => {
    response.headers.set("content-security-policy", csp);
    return response;
  };

  const raw = request.cookies.get(cookieName)?.value;
  const session = await openSession(raw, SESSION_SECRET);

  if (!session) {
    if (isProtected) return withCsp(NextResponse.redirect(new URL("/", request.url)));
    return withCsp(proceed());
  }

  if (!isExpiring(session)) return withCsp(proceed());

  try {
    const refreshed = await refreshSession(session);
    const sealed = await sealSession(refreshed, SESSION_SECRET);

    // Set on the request first so this request's render sees the fresh token...
    request.cookies.set(cookieName, sealed);
    const response = proceed();
    // ...and on the response so the browser keeps it.
    response.cookies.set(cookieName, sealed, {
      ...cookieOptions(APP_URL),
      maxAge: SESSION.MAX_AGE_SECONDS,
    });
    return withCsp(response);
  } catch {
    // Refresh token spent, revoked, or the app's authorization was withdrawn.
    const target = isProtected
      ? new URL("/?error=session_expired", request.url)
      : request.url;
    const response = isProtected ? NextResponse.redirect(target) : proceed();
    response.cookies.delete(cookieName);
    return withCsp(response);
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
