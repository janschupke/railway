import * as client from "openid-client";
import { NextResponse, type NextRequest } from "next/server";
import { callbackUrl, env } from "@/env";
import { SCOPES, oidcConfig } from "@/lib/auth/oidc";
import { log } from "@/lib/logger";
import { withRequestScope } from "@/lib/log/request-scope";
import { SESSION } from "@/lib/constants";
import { CONSENT_PARAM, cookieOptions, transientCookieNames } from "@/lib/auth/session";

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
  const { APP_URL } = env();
  const forceConsent = request.nextUrl.searchParams.get(CONSENT_PARAM) === "1";

  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = client.randomState();

  const authorizationUrl = client.buildAuthorizationUrl(oidcConfig(), {
    redirect_uri: callbackUrl(),
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
    ...cookieOptions(APP_URL),
    maxAge: SESSION.TRANSIENT_MAX_AGE_SECONDS,
  };
  const names = transientCookieNames(APP_URL);
  response.cookies.set(names.pkce, codeVerifier, opts);
  response.cookies.set(names.state, state, opts);

  // Records which kind of attempt this is, so the callback's retry cannot become a loop.
  if (forceConsent) response.cookies.set(names.consent, "1", opts);
  else response.cookies.delete(names.consent);

  // debug: no identity is known yet and it is one redirect. It earns its place only as
  // the denominator for an abandoned-sign-in rate, which is not an every-deploy question.
  log.debug("auth.login.started", { forced_consent: forceConsent });

  return response;
}
