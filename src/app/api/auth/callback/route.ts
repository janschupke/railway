import * as client from "openid-client";
import { NextResponse, type NextRequest } from "next/server";
import { callbackUrl, env } from "@/env";
import { oidcConfig } from "@/lib/auth/oidc";
import { describeOidcFailure } from "@/lib/auth/redact";
import { log } from "@/lib/logger";
import { withRequestScope } from "@/lib/log/request-scope";
import { SESSION } from "@/lib/constants";
import {
  CONSENT_COOKIE,
  CONSENT_PARAM,
  PKCE_COOKIE,
  STATE_COOKIE,
  cookieOptions,
  sealSession,
  sessionCookieName,
  type RailwaySession,
} from "@/lib/auth/session";

function clearTransients<T extends NextResponse>(response: T): T {
  response.cookies.delete(PKCE_COOKIE);
  response.cookies.delete(STATE_COOKIE);
  response.cookies.delete(CONSENT_COOKIE);
  return response;
}

/**
 * The single exit for every rejected callback, which is why the log line lives here:
 * five branches — a missing PKCE verifier or state, the provider's own `?error=`, a
 * failed exchange, a response with no `sub`, and a grant that withheld a refresh token —
 * were all silent, and one line closes all five without any chance of drifting apart.
 */
function fail(request: NextRequest, reason: string) {
  log.warn("auth.callback.failed", { reason });
  const url = new URL(`/?error=${encodeURIComponent(reason)}`, request.url);
  return clearTransients(NextResponse.redirect(url));
}

/**
 * The browser only ever learns `token_exchange_failed`, so unless the real reason is
 * recorded here it is lost — which is how an id_token signing-algorithm mismatch spent
 * a while masquerading as a redirect-URI problem.
 *
 * This used to log `error.cause`, which is where openid-client puts the specifics. That
 * was the wrong instinct: on one branch `cause` is the parsed token response, so the
 * line wrote a live access and refresh token into Railway's retained logs. The reason
 * still has to be recorded — through an allow-list. See lib/auth/redact.ts.
 *
 * The redactor's *string* result is what reaches the logger, so the raw error never
 * enters the logging path at all and the guarantee does not depend on the serializer.
 */
function logExchangeFailure(error: unknown) {
  log.error("auth.callback.token_exchange_failed", {
    reason: describeOidcFailure(error),
  });
}

export async function GET(request: NextRequest) {
  // trustInboundId: false — the proxy matcher excludes api/auth, so nothing has
  // overwritten a client-supplied header by the time it gets here.
  return withRequestScope("/api/auth/callback", { trustInboundId: false }, () =>
    complete(request),
  );
}

async function complete(request: NextRequest) {
  const { APP_URL, SESSION_SECRET } = env();

  const codeVerifier = request.cookies.get(PKCE_COOKIE)?.value;
  const expectedState = request.cookies.get(STATE_COOKIE)?.value;
  if (!codeVerifier || !expectedState) {
    return fail(request, "missing_pkce_state");
  }

  // The user declined consent, or Railway rejected the request.
  const error = request.nextUrl.searchParams.get("error");
  if (error) return fail(request, error);

  /*
   * Rebuild the callback URL from APP_URL rather than trusting request.url: behind
   * Railway's proxy the incoming URL carries the internal host, and openid-client
   * compares it against the registered redirect_uri.
   */
  const currentUrl = new URL(callbackUrl());
  currentUrl.search = request.nextUrl.search;

  const tokens = await client
    .authorizationCodeGrant(oidcConfig(), currentUrl, {
      pkceCodeVerifier: codeVerifier,
      expectedState,
    })
    .catch((error: unknown) => {
      logExchangeFailure(error);
      return null;
    });

  if (!tokens) return fail(request, "token_exchange_failed");

  const claims = tokens.claims();
  if (!claims?.sub) return fail(request, "missing_id_token");

  if (!tokens.refresh_token) {
    /*
     * Without a refresh token the session dies in one hour, mid-use.
     *
     * Railway mints one on the flow where consent is granted, so a silent authorization
     * that skipped the consent screen can legitimately return none. That is worth one
     * automatic retry with consent forced — this used to dead-end on an error page
     * telling the user to sign in again and approve offline access, which sent them
     * through the identical request and produced the identical result.
     *
     * The cookie set by that forced attempt is what stops this becoming a loop: if it
     * is already here, consent has been shown and Railway still withheld the token, so
     * there is nothing left to try.
     */
    if (request.cookies.get(CONSENT_COOKIE)?.value === "1") {
      return fail(request, "no_refresh_token");
    }
    const retry = new URL(`/api/auth/login?${CONSENT_PARAM}=1`, request.url);
    return clearTransients(NextResponse.redirect(retry));
  }

  const session: RailwaySession = {
    user: {
      id: claims.sub,
      name: typeof claims.name === "string" ? claims.name : undefined,
      email: typeof claims.email === "string" ? claims.email : undefined,
      image: typeof claims.picture === "string" ? claims.picture : undefined,
    },
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Math.floor(Date.now() / 1000) + (tokens.expires_in ?? 3600),
    scope: tokens.scope ?? "",
  };

  /*
   * `scope` is recorded once, here, rather than on every dashboard render: it is what
   * makes an under-scoped session diagnosable after the fact, and the render-time
   * `missingScopes` computation is derivable from it. Subject only — never the email,
   * name or picture the claims also carry.
   */
  log.info("auth.session.created", {
    subject_id: claims.sub,
    scope: session.scope,
    expires_in_s: session.expiresAt - Math.floor(Date.now() / 1000),
  });

  const response = NextResponse.redirect(new URL("/dashboard", request.url));
  response.cookies.set(
    sessionCookieName(APP_URL),
    await sealSession(session, SESSION_SECRET),
    { ...cookieOptions(APP_URL), maxAge: SESSION.MAX_AGE_SECONDS },
  );
  return clearTransients(response);
}
