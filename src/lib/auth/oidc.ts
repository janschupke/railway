import * as client from "openid-client";
import { env } from "@/env";

/**
 * Railway's OpenID Connect metadata, derived from the issuer.
 *
 * Verified live at https://backboard.railway.com/oauth/.well-known/openid-configuration
 * (note the `/oauth` segment — the domain root 404s).
 *
 * It is constructed here rather than discovered at boot for two reasons:
 *  1. The discovery document lives under `/oauth` but declares `issuer` as the bare
 *     domain. RFC 8414 issuer validation rejects that mismatch, so `client.discovery()`
 *     cannot be pointed at it directly.
 *  2. No network round-trip on cold start, and no boot-time dependency on Railway
 *     being reachable.
 *
 * `pnpm verify:schema` re-fetches the live document and diffs it against this shape.
 */
export function railwayMetadata(issuer: string): client.ServerMetadata {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/auth`,
    token_endpoint: `${issuer}/oauth/token`,
    userinfo_endpoint: `${issuer}/oauth/me`,
    jwks_uri: `${issuer}/oauth/jwks`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
  };
}

export function discoveryUrl(issuer: string): string {
  return `${issuer}/oauth/.well-known/openid-configuration`;
}

/**
 * Scopes requested at consent.
 *
 * - `offline_access` is what earns a refresh token, and it only takes effect when
 *   the authorization request also carries `prompt=consent`.
 * - `project:admin` is the write-capable project scope. It appears in the live
 *   discovery document's `scopes_supported` but is absent from the prose scope
 *   table in Railway's docs, which lists only viewer/member for projects.
 */
export const SCOPES = [
  "openid",
  "email",
  "profile",
  "offline_access",
  "project:admin",
] as const;

let config: client.Configuration | undefined;

export function oidcConfig(): client.Configuration {
  if (config) return config;
  const { RAILWAY_CLIENT_ID, RAILWAY_CLIENT_SECRET, RAILWAY_ISSUER } = env();

  config = new client.Configuration(
    railwayMetadata(RAILWAY_ISSUER),
    RAILWAY_CLIENT_ID,
    { client_secret: RAILWAY_CLIENT_SECRET },
    // Railway's token endpoint authenticates the client with HTTP Basic.
    client.ClientSecretBasic(RAILWAY_CLIENT_SECRET),
  );

  /*
   * openid-client refuses plaintext HTTP, correctly — tokens over http: are tokens in
   * the clear. The E2E fixture runs on http://localhost, so the guard is relaxed only
   * when the issuer is not https. Railway's real issuer always is, so this branch can
   * never be taken in production, and no environment variable can force it.
   */
  if (!RAILWAY_ISSUER.startsWith("https://")) {
    client.allowInsecureRequests(config);
  }

  return config;
}

/** Reset memoised config. Tests only. */
export function __resetOidcConfig() {
  config = undefined;
}
