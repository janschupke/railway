import * as client from "openid-client";
import { SESSION } from "@/lib/constants";
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

type RetainedGrant = {
  result: Promise<RailwaySession>;
  /** Epoch ms after which this entry stops being served. Infinite while in flight. */
  retainUntil: number;
};

/**
 * Which session replaced which refresh token, keyed by the token that was spent.
 *
 * Railway rotates refresh tokens: the first use invalidates the token. A single
 * dashboard load issues many requests that all pass through the proxy carrying the same
 * cookie — the document, its RSC payloads, and up to STREAM.MAX_CONCURRENT_PER_USER log
 * streams — so without this they each opened their own grant with the same token, one
 * won, and every other one got `invalid_grant` and concluded the session was dead. That
 * is the mechanism behind "it made me authorize again a million times".
 *
 * Deduping only the *in-flight* window closed half of that. A request that was already
 * on its way with the old cookie when the winner's grant resolved found the entry gone,
 * spent the dead token itself, and was signed out of a session that had just been
 * refreshed successfully. So a fulfilled entry is retained for
 * SESSION.REFRESH_GRACE_SECONDS rather than deleted: a caller that lost the race by
 * milliseconds is handed the live session instead of a consent screen.
 *
 * A rejected entry is deleted immediately — a failure must stay retryable, and caching
 * one would turn a single upstream blip into a sign-out for the whole grace window.
 *
 * Keyed by token rather than by user so an entry can never serve a caller holding a
 * different (older or newer) token. Retaining the rotated tokens under the spent one
 * widens no exposure: the spent token only ever reaches this map out of a JWE-sealed
 * cookie, and anyone able to replay that cookie already holds the live access token
 * inside it.
 *
 * Per bundle, not per process — see `requireSession` in ./server.ts for why the proxy is
 * the only caller that refreshes.
 */
const grants = new Map<string, RetainedGrant>();

/** Drop entries whose grace window has closed. Lazy: no timer runs in the proxy. */
function sweep(nowMs: number): void {
  for (const [token, entry] of grants) {
    if (entry.retainUntil <= nowMs) grants.delete(token);
  }
}

/** Test seam: the retention is process-global and would otherwise leak across cases. */
export function __resetRefreshCache(): void {
  grants.clear();
}

/**
 * Exchange the refresh token for a new access token.
 *
 * Railway rotates refresh tokens on every use, so the returned session carries the
 * NEW refresh token and the caller must persist it. Dropping it strands the session:
 * the old token is already spent, and a user is capped at 100 live refresh tokens
 * per authorization.
 *
 * Callers holding the same refresh token share one grant, whether they arrive together
 * or seconds apart — see `grants`.
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

  sweep(now());

  const existing = grants.get(token);
  if (existing) return existing.result;

  const pending = grant(session, token, now);
  const entry: RetainedGrant = {
    result: pending,
    retainUntil: Number.POSITIVE_INFINITY,
  };
  grants.set(token, entry);

  /*
   * `.then(ok, err)` rather than `.finally`: the two branches differ, and passing a
   * rejection handler here means this bookkeeping never registers an unhandled rejection
   * of its own. The identity check keeps a settling promise from touching an entry that a
   * later call has already replaced under the same key.
   */
  pending.then(
    () => {
      if (grants.get(token) === entry) {
        entry.retainUntil = now() + SESSION.REFRESH_GRACE_SECONDS * 1000;
      }
    },
    () => {
      if (grants.get(token) === entry) grants.delete(token);
    },
  );

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
