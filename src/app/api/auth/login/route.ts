import * as client from "openid-client";
import { NextResponse, type NextRequest } from "next/server";
import { callbackUrl } from "@/lib/origin";
import { badOrigin, requestOrigin } from "@/lib/auth/request-origin";
import { SCOPES, oidcConfig } from "@/lib/auth/oidc";
import { log } from "@/lib/logger";
import { withRequestScope } from "@/lib/log/request-scope";
import { SESSION } from "@/lib/constants";
import {
  clearCookie,
  CONSENT_PARAM,
  cookieOptions,
  transientCookieNames,
} from "@/lib/auth/session";

/**
 * Starts the authorization flow.
 *
 * `?consent=1` forces Railway's consent screen. Without it Railway decides, which is the
 * behaviour worth having: the first sign-in shows the screen because no grant exists
 * yet, and every later one redirects straight back. This used to send `prompt=consent`
 * unconditionally — an override meaning "show it every time regardless" — so choosing
 * projects again was the price of every single sign-in.
 */
export async function GET(request: NextRequest) {
  return withRequestScope("/api/auth/login", { trustInboundId: false }, () =>
    start(request),
  );
}

async function start(request: NextRequest) {
  /*
   * The origin this request arrived at, which is the one the whole flow is conducted
   * against: the redirect_uri sent to Railway, the cookies that guard the callback, and
   * the callback's own address. It must be registered on the Railway OAuth app, so a
   * domain nobody registered fails at the provider rather than here.
   */
  const origin = requestOrigin(request);
  if (!origin) return badOrigin();

  const forceConsent = request.nextUrl.searchParams.get(CONSENT_PARAM) === "1";

  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = client.randomState();

  const authorizationUrl = client.buildAuthorizationUrl(oidcConfig(), {
    redirect_uri: callbackUrl(origin),
    scope: SCOPES.join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    /*
     * Only when asked for. A silent authorization can come back without a refresh
     * token, since some providers mint one only on a flow where consent was displayed —
     * the callback detects exactly that and retries here with consent forced, which
     * costs one redirect in the rare case instead of a consent screen in every case.
     */
    ...(forceConsent ? { prompt: "consent" } : {}),
  });

  const response = NextResponse.redirect(authorizationUrl.href);
  const opts = {
    ...cookieOptions(origin),
    maxAge: SESSION.TRANSIENT_MAX_AGE_SECONDS,
  };
  const names = transientCookieNames(origin);
  response.cookies.set(names.pkce, codeVerifier, opts);
  response.cookies.set(names.state, state, opts);

  // Records which kind of attempt this is, so the callback's retry cannot become a loop.
  if (forceConsent) response.cookies.set(names.consent, "1", opts);
  else clearCookie(response.cookies, names.consent, origin);

  // debug: no identity is known yet and it is one redirect. It earns its place only as
  // the denominator for an abandoned-sign-in rate, which is not an every-deploy question.
  log.debug("auth.login.started", { forced_consent: forceConsent });

  return response;
}
