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
 * In-flight refreshes, keyed by the token being spent.
 *
 * Railway rotates refresh tokens: the first use invalidates the token. A single
 * dashboard load issues many requests that all pass through the proxy carrying the same
 * cookie — the document, its RSC payloads, and up to STREAM.MAX_CONCURRENT_PER_USER log
 * streams — so without this they each opened their own grant with the same token, one
 * won, and every other one got `invalid_grant` and concluded the session was dead. That
 * is the mechanism behind "it made me authorize again a million times".
 *
 * Keyed by token rather than by user so an entry can never serve a caller holding a
 * different (older or newer) token, and deleted on settle so a failure is retryable.
 */
const inFlight = new Map<string, Promise<RailwaySession>>();

/**
 * Exchange the refresh token for a new access token.
 *
 * Railway rotates refresh tokens on every use, so the returned session carries the
 * NEW refresh token and the caller must persist it. Dropping it strands the session:
 * the old token is already spent, and a user is capped at 100 live refresh tokens
 * per authorization.
 *
 * Concurrent callers holding the same refresh token share one grant — see `inFlight`.
 */
export async function refreshSession(
  session: RailwaySession,
  now: () => number = Date.now,
): Promise<RailwaySession> {
  const token = session.refreshToken;
  if (!token) {
    // No `offline_access` at consent — nothing to refresh with.
    throw new SessionExpiredError("no refresh token in session");
  }

  const existing = inFlight.get(token);
  if (existing) return existing;

  const pending = grant(session, token, now).finally(() => {
    inFlight.delete(token);
  });
  inFlight.set(token, pending);
  return pending;
}

async function grant(
  session: RailwaySession,
  refreshToken: string,
  now: () => number,
): Promise<RailwaySession> {
  let tokens: client.TokenEndpointResponse;
  try {
    tokens = await client.refreshTokenGrant(oidcConfig(), refreshToken);
  } catch (cause) {
    throw new SessionExpiredError(cause);
  }

  return {
    // The refresh response has no id_token, so identity claims carry over.
    user: session.user,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? refreshToken,
    expiresAt: Math.floor(now() / 1000) + (tokens.expires_in ?? 3600),
    scope: tokens.scope ?? session.scope,
  };
}
