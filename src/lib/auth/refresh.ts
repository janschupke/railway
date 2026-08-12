import * as client from "openid-client";
import type { RailwaySession } from "./session";
import { oidcConfig } from "./oidc";

/** The refresh grant failed — the user must re-authorize. Not retryable. */
export class SessionExpiredError extends Error {
  constructor(cause?: unknown) {
    super("Railway session expired; re-authorization required");
    this.name = "SessionExpiredError";
    this.cause = cause;
  }
}

/**
 * Exchange the refresh token for a new access token.
 *
 * Railway rotates refresh tokens on every use, so the returned session carries the
 * NEW refresh token and the caller must persist it. Dropping it strands the session:
 * the old token is already spent, and a user is capped at 100 live refresh tokens
 * per authorization.
 */
export async function refreshSession(
  session: RailwaySession,
  now: () => number = Date.now,
): Promise<RailwaySession> {
  if (!session.refreshToken) {
    // No `offline_access` at consent — nothing to refresh with.
    throw new SessionExpiredError("no refresh token in session");
  }

  let tokens: client.TokenEndpointResponse;
  try {
    tokens = await client.refreshTokenGrant(oidcConfig(), session.refreshToken);
  } catch (cause) {
    throw new SessionExpiredError(cause);
  }

  return {
    // The refresh response has no id_token, so identity claims carry over.
    user: session.user,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? session.refreshToken,
    expiresAt:
      Math.floor(now() / 1000) + (tokens.expires_in ?? 3600),
    scope: tokens.scope ?? session.scope,
  };
}
