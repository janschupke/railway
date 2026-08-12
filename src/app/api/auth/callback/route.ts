import * as client from "openid-client";
import { NextResponse, type NextRequest } from "next/server";
import { callbackUrl, env } from "@/env";
import { oidcConfig } from "@/lib/auth/oidc";
import { describeOidcFailure } from "@/lib/auth/redact";
import { SESSION } from "@/lib/constants";
import {
  PKCE_COOKIE,
  STATE_COOKIE,
  cookieOptions,
  sealSession,
  sessionCookieName,
  type RailwaySession,
} from "@/lib/auth/session";

function fail(request: NextRequest, reason: string) {
  const url = new URL(`/?error=${encodeURIComponent(reason)}`, request.url);
  const response = NextResponse.redirect(url);
  response.cookies.delete(PKCE_COOKIE);
  response.cookies.delete(STATE_COOKIE);
  return response;
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
 */
function logExchangeFailure(error: unknown) {
  console.error("token exchange failed:", describeOidcFailure(error));
}

export async function GET(request: NextRequest) {
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
     * Without a refresh token the session dies in one hour, mid-use. Better to say so
     * now than to fail an action later; the landing page explains how to fix it.
     */
    return fail(request, "no_refresh_token");
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

  const response = NextResponse.redirect(new URL("/dashboard", request.url));
  response.cookies.set(
    sessionCookieName(APP_URL),
    await sealSession(session, SESSION_SECRET),
    { ...cookieOptions(APP_URL), maxAge: SESSION.MAX_AGE_SECONDS },
  );
  response.cookies.delete(PKCE_COOKIE);
  response.cookies.delete(STATE_COOKIE);
  return response;
}
