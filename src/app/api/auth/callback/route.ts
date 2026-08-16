import * as client from "openid-client";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/env";
import { callbackUrl, type AppOrigin } from "@/lib/origin";
import { badOrigin, requestOrigin } from "@/lib/auth/request-origin";
import { oidcConfig } from "@/lib/auth/oidc";
import { classifyProviderError, describeOidcFailure } from "@/lib/auth/redact";
import { log } from "@/lib/logger";
import { withRequestScope } from "@/lib/log/request-scope";
import { SESSION } from "@/lib/constants";
import {
  clearCookie,
  CONSENT_PARAM,
  cookieOptions,
  sealSession,
  sessionCookieName,
  transientCookieNames,
  type RailwaySession,
} from "@/lib/auth/session";

function clearTransients<T extends NextResponse>(response: T, origin: AppOrigin): T {
  const names = transientCookieNames(origin);
  for (const name of [names.pkce, names.state, names.consent]) {
    clearCookie(response.cookies, name, origin);
  }
  return response;
}

/**
 * The single exit for every rejected callback, which is why the log line lives here:
 * five branches — a missing PKCE verifier or state, the provider's own `?error=`, a
 * failed exchange, a response with no `sub`, and a grant that withheld a refresh token —
 * were all silent, and one line closes all five without any chance of drifting apart.
 *
 * `origin` is the base, not `request.url`, for the reason given at the exchange below and
 * measured on the deployed image: in a route handler `request.url` is the *internal*
 * origin, `http://localhost:<PORT>`, because Next's standalone server builds it from its
 * own bind address. A route handler's redirect goes out as the absolute URL it was given,
 * so that origin lands in the browser's address bar.
 */
function fail(origin: AppOrigin, reason: string) {
  log.warn("auth.callback.failed", { reason });
  const url = new URL(`/?error=${encodeURIComponent(reason)}`, origin);
  return clearTransients(NextResponse.redirect(url), origin);
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
  const { SESSION_SECRET } = env();

  /*
   * The same origin the login route conducted its half of the flow against — Railway sent
   * the browser here by way of the redirect_uri that named it, and the transient cookies
   * below were set on it. Nothing has to be carried across the round trip for that to
   * hold: a callback arriving on some other domain finds no PKCE verifier there, because
   * `__Host-` scopes those cookies to exactly one origin, and fails on the next line.
   */
  const origin = requestOrigin(request);
  if (!origin) return badOrigin();

  const names = transientCookieNames(origin);
  const codeVerifier = request.cookies.get(names.pkce)?.value;
  const expectedState = request.cookies.get(names.state)?.value;
  if (!codeVerifier || !expectedState) {
    return fail(origin, "missing_pkce_state");
  }

  /*
   * The user declined consent, or Railway rejected the request.
   *
   * Classified rather than passed through: this is the one `fail` reason that does not
   * originate here, and a query parameter anyone can write was going verbatim into
   * `auth.callback.failed` — the same unbounded-cardinality trap the rejected
   * deploymentId is deliberately kept out of. The landing page renders any code it does
   * not recognise as the same sentence, so nothing the user sees changes.
   */
  const error = request.nextUrl.searchParams.get("error");
  if (error) return fail(origin, classifyProviderError(error));

  /*
   * Rebuild the callback URL from the resolved origin rather than trusting request.url:
   * behind Railway's proxy the incoming URL carries the container's internal host, and
   * openid-client compares this against the redirect_uri the login route sent. Those two
   * agree because both are derived from the request's own headers.
   */
  const currentUrl = new URL(callbackUrl(origin));
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

  if (!tokens) return fail(origin, "token_exchange_failed");

  const claims = tokens.claims();
  if (!claims?.sub) return fail(origin, "missing_id_token");

  if (!tokens.refresh_token) {
    /*
     * Without a refresh token the session dies in one hour, mid-use.
     *
     * The login route sends `prompt=consent` and `offline_access` on every request, which
     * is Railway's stated condition for issuing one — so reaching here means the user
     * declined offline access at the screen, or Railway withheld it for a reason of its
     * own. Neither is fixed by asking again with the same parameters, but one retry is
     * still worth it: it costs a redirect and it covers a provider that behaves
     * differently from its documentation, which is the case this app cannot see.
     *
     * The cookie set by that retry is what stops this becoming a loop: if it is already
     * here, the second attempt failed the same way and there is nothing left to try.
     */
    if (request.cookies.get(names.consent)?.value === "1") {
      return fail(origin, "no_refresh_token");
    }
    // The resolved origin, not request.url. This is the redirect that shipped the internal
    // origin to a real browser: a grant with no refresh token sent the user to
    // https://localhost:<PORT>/api/auth/login?consent=1, which is a dead address anywhere
    // but inside the container.
    const retry = new URL(`/api/auth/login?${CONSENT_PARAM}=1`, origin);
    return clearTransients(NextResponse.redirect(retry), origin);
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
    expiresAt:
      Math.floor(Date.now() / 1000) +
      (tokens.expires_in ?? SESSION.DEFAULT_EXPIRES_IN_SECONDS),
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

  // Same base as every other exit here, for the same reason.
  const response = NextResponse.redirect(new URL("/dashboard", origin));
  response.cookies.set(
    sessionCookieName(origin),
    await sealSession(session, SESSION_SECRET),
    { ...cookieOptions(origin), maxAge: SESSION.MAX_AGE_SECONDS },
  );
  return clearTransients(response, origin);
}
