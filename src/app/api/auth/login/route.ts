import * as client from "openid-client";
import { NextResponse } from "next/server";
import { callbackUrl, env } from "@/env";
import { SCOPES, oidcConfig } from "@/lib/auth/oidc";
import { PKCE_COOKIE, STATE_COOKIE, cookieOptions } from "@/lib/auth/session";

/** PKCE verifier and state only need to survive the round-trip to Railway. */
const TRANSIENT_MAX_AGE = 60 * 10;

export async function GET() {
  const { APP_URL } = env();

  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = client.randomState();

  const authorizationUrl = client.buildAuthorizationUrl(oidcConfig(), {
    redirect_uri: callbackUrl(),
    scope: SCOPES.join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    // Required to actually receive a refresh token alongside `offline_access`.
    // Without it Railway may skip consent and return an access token only.
    prompt: "consent",
  });

  const response = NextResponse.redirect(authorizationUrl.href);
  const opts = { ...cookieOptions(APP_URL), maxAge: TRANSIENT_MAX_AGE };
  response.cookies.set(PKCE_COOKIE, codeVerifier, opts);
  response.cookies.set(STATE_COOKIE, state, opts);
  return response;
}
