import type * as client from "openid-client";

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
 * It lives in its own module, free of `@/` aliases and runtime imports, so that script
 * can import the real values instead of restating them.
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
    /*
     * Load-bearing. Railway signs id_tokens with ES256 and its JWKS holds a single
     * P-256 key. Omit this and oauth4webapi falls back to its RS256 default, rejecting
     * every id_token during the code exchange — which surfaces as a generic
     * token_exchange_failed long after the token endpoint has answered successfully.
     */
    id_token_signing_alg_values_supported: ["ES256"],
    /*
     * Informational — neither openid-client nor oauth4webapi reads this. Recorded so
     * `verify:schema` can assert client_secret_basic is still on offer, since
     * `oidcConfig()` commits to it.
     *
     * Deliberately NOT pinned: `authorization_response_iss_parameter_supported`. Live
     * discovery declares it true, but setting it here makes an `iss` query parameter
     * mandatory on the callback, and that is unverifiable without a real sign-in.
     *
     * Absent rather than forgotten: `revocation_endpoint` and `end_session_endpoint`.
     * Railway publishes neither, so there is no URL to pin and nothing for sign-out to
     * call — see `ABSENT_ENDPOINTS` in scripts/verify-schema.ts, which asserts they are
     * still missing on every push, and the accepted risk in SECURITY.md.
     */
    token_endpoint_auth_methods_supported: [
      "client_secret_basic",
      "client_secret_post",
      "none",
      "private_key_jwt",
    ],
  };
}

export function discoveryUrl(issuer: string): string {
  return `${issuer}/oauth/.well-known/openid-configuration`;
}
