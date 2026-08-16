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
 * `prompt=consent` goes on every request, because Railway issues a refresh token only for
 * an authorization that carries both `offline_access` and `prompt=consent`. Its own docs
 * say so in two places — Login & Tokens, and Troubleshooting under "Refresh token not
 * returned" — and a session without a refresh token dies one hour in, mid-use.
 *
 * This was omitted once, on the belief that Railway would re-grant silently for a user who
 * had already authorized and that the consent screen was therefore the price of every
 * sign-in. The screen was shown every time either way: the silent request came back with no
 * refresh token, the callback retried with consent forced, and the user reached the same
 * screen one redirect later. The parameter is back and the retry is now the rare path it
 * was written to be. Do not remove it again without evidence that Railway has changed.
 *
 * `?consent=1` therefore no longer changes what is sent. It survives as the record of
 * *why* an attempt was made — the callback reads its cookie to know consent has already
 * been shown, which is what stops the retry becoming a loop.
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
     * Unconditional. See the docblock above: `offline_access` in SCOPES is only half of
     * Railway's condition for issuing a refresh token, and this is the other half.
     */
    prompt: "consent",
  });

  const response = NextResponse.redirect(authorizationUrl.href);
  const opts = {
    ...cookieOptions(origin),
    maxAge: SESSION.TRANSIENT_MAX_AGE_SECONDS,
  };
  const names = transientCookieNames(origin);
  response.cookies.set(names.pkce, codeVerifier, opts);
  response.cookies.set(names.state, state, opts);

  // Records that this attempt is the callback's retry, so that retry cannot become a loop.
  // The request itself is identical either way now; only the cookie differs.
  if (forceConsent) response.cookies.set(names.consent, "1", opts);
  else clearCookie(response.cookies, names.consent, origin);

  // debug: no identity is known yet and it is one redirect. It earns its place only as
  // the denominator for an abandoned-sign-in rate, which is not an every-deploy question.
  log.debug("auth.login.started", { forced_consent: forceConsent });

  return response;
}
