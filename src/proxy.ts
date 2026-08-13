import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/env";
import { SESSION } from "@/lib/constants";
import {
  clearCookie,
  cookieOptions,
  isExpiring,
  openSession,
  sealSession,
  sessionCookieName,
} from "@/lib/auth/session";
import { refreshSession } from "@/lib/auth/refresh";
import { contentSecurityPolicy, generateNonce } from "@/lib/security-headers";
import { log } from "@/lib/logger";
import { newRequestId } from "@/lib/log/context";

const PROTECTED = ["/dashboard"];

/**
 * A misconfigured deployment fails here first, and used to fail silently.
 *
 * The throw is preserved; only the record is new. Logged once per process rather than
 * per request, because every navigation hits this and the second line says nothing the
 * first did not.
 *
 * `/api/health` is no longer among those requests — it is excluded from the matcher
 * below so its own handler can answer 503 for exactly this case, which is what Railway's
 * healthcheck should see instead of a bare 500 from here.
 */
let envFailureLogged = false;

function readEnv() {
  try {
    return env();
  } catch (error) {
    if (!envFailureLogged) {
      envFailureLogged = true;
      // The zod issue list names variables, never values — see env.ts.
      log.error("proxy.env_invalid", { issues: (error as Error).message });
    }
    throw error;
  }
}

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

  const { SESSION_SECRET, APP_URL } = readEnv();
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
   * Minted here, never adopted from the request.
   *
   * The proxy and the render are separate invocations — Next prescribes headers as the
   * channel between them, which is the same mechanism the nonce already rides. Taking a
   * client-supplied value instead would put attacker-chosen bytes into a field operators
   * grep, give Loki an unbounded label, and let a caller stitch its requests onto someone
   * else's chain. `headers.set` below overwrites any inbound value unconditionally.
   */
  const requestId = newRequestId();

  /*
   * Snapshotted at call time, not once up front: the refresh branch mutates
   * request.cookies first, and that mutation has to be in the headers this forwards.
   */
  const forwarded = () => {
    const headers = new Headers(request.headers);
    headers.set("content-security-policy", csp);
    headers.set("x-nonce", nonce);
    headers.set("x-request-id", requestId);
    return headers;
  };

  const proceed = () => NextResponse.next({ request: { headers: forwarded() } });

  const withCsp = <T extends NextResponse>(response: T): T => {
    response.headers.set("content-security-policy", csp);
    // On the response too, so the browser's network tab is a correlation tool.
    response.headers.set("x-request-id", requestId);
    return response;
  };

  const raw = request.cookies.get(cookieName)?.value;
  const session = await openSession(raw, SESSION_SECRET);

  if (!session) {
    if (raw) {
      /*
       * A cookie was presented and could not be opened. openSession swallows the reason
       * by design — a tampered token, an expired JWE and a rotated SESSION_SECRET are
       * indistinguishable to it — but "someone is presenting an unreadable session" is
       * worth seeing, and a burst of these is what a rotated secret looks like.
       */
      log.warn("auth.session.unreadable", { request_id: requestId, path: pathname });
    } else if (isProtected) {
      log.debug("auth.redirect.anonymous", { request_id: requestId, path: pathname });
    }
    if (isProtected) return withCsp(NextResponse.redirect(new URL("/", request.url)));
    return withCsp(proceed());
  }

  // The hot path. Deliberately silent: a line here is an access log, which Railway
  // already emits and which nobody asked this app to duplicate.
  if (!isExpiring(session)) return withCsp(proceed());

  try {
    const refreshed = await refreshSession(session);
    const sealed = await sealSession(refreshed, SESSION_SECRET);

    log.info("auth.session.refreshed", {
      request_id: requestId,
      subject_id: session.user.id,
      expires_in_s: refreshed.expiresAt - Math.floor(Date.now() / 1000),
    });

    // Set on the request first so this request's render sees the fresh token...
    request.cookies.set(cookieName, sealed);
    const response = proceed();
    // ...and on the response so the browser keeps it.
    response.cookies.set(cookieName, sealed, {
      ...cookieOptions(APP_URL),
      maxAge: SESSION.MAX_AGE_SECONDS,
    });
    return withCsp(response);
  } catch (error) {
    /*
     * A failed refresh is not proof the session is gone.
     *
     * Refresh tokens rotate, so a request that lost a race spends a token another
     * request has already replaced — and deleting the cookie here threw away a session
     * that had just been refreshed successfully, sending the user back to the consent
     * screen for no reason. refreshSession now shares one grant between concurrent
     * callers, and this re-read closes the remaining window: if the jar already holds a
     * newer session, use it and delete nothing.
     */
    const current = await openSession(
      request.cookies.get(cookieName)?.value,
      SESSION_SECRET,
    );
    if (current && current.expiresAt > session.expiresAt) {
      // Lost a race, not expired. Separated from the line below because conflating them
      // is what made a healthy session look like a revoked authorization.
      log.debug("auth.session.refresh_raced", {
        request_id: requestId,
        subject_id: session.user.id,
      });
      return withCsp(proceed());
    }

    /*
     * Genuinely spent, revoked, or the authorization was withdrawn. Cleared on the
     * request *before* the response is built — `forwarded()` snapshots the jar at call
     * time, and deleting only on the response left this render still seeing the dead
     * session, so the landing page redirected to /dashboard, which redirected back: a
     * bounce with no error shown.
     */
    /*
     * The single most important line in this file. Until now this branch discarded the
     * cause entirely and sent the user to `/?error=session_expired` with nothing written
     * anywhere — a revoked grant, a spent token and an upstream outage all looked
     * identical from the outside. `error` is a SessionExpiredError whose `.cause` is the
     * raw openid-client failure; the serializer never reads it, and a test says so.
     */
    log.warn("auth.session.refresh_failed", {
      request_id: requestId,
      subject_id: session.user.id,
      protected: isProtected,
      error,
    });
    request.cookies.delete(cookieName);
    const target = isProtected
      ? new URL("/?error=session_expired", request.url)
      : request.url;
    const response = isProtected ? NextResponse.redirect(target) : proceed();
    clearCookie(response.cookies, cookieName, APP_URL);
    return withCsp(response);
  }
}

export const config = {
  matcher: [
    /*
     * Everything except static assets, the auth routes themselves and the healthcheck.
     *
     * The auth routes mint the session and must not be gated by it.
     *
     * api/health is excluded so its own handler runs. This proxy calls env() first, so a
     * misconfigured deployment threw here and Railway's healthcheck saw a bare 500 —
     * while the route whose entire job is to report that condition, and which answers
     * 503 {"status":"misconfigured"} with the issue list going to the log rather than to
     * the caller, was unreachable. It needs no session, so nothing is given up: it now
     * pays no HKDF derive either, on an endpoint polled every few seconds.
     *
     * icon.svg sits beside favicon.ico for the reason next.config.ts already gives for
     * the two _next paths: a matched request pays an HKDF derive and a JWE decrypt, and
     * a favicon is fetched on every cold tab. The static security headers still reach it,
     * because next.config.ts sets those on /:path* independently of this matcher.
     */
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|api/auth|api/health).*)",
  ],
};
