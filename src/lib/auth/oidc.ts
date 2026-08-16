import * as client from "openid-client";
import { env } from "@/env";
import { railwayMetadata } from "@/lib/auth/oidc-metadata";

export { discoveryUrl, railwayMetadata } from "@/lib/auth/oidc-metadata";

/**
 * Scopes requested at consent.
 *
 * - `offline_access` is half of what earns a refresh token. Railway's condition is both
 *   this scope and `prompt=consent` on the authorization request, which is why the login
 *   route sends that parameter unconditionally. Either one alone yields an access token
 *   that expires in an hour and nothing to renew it with.
 * - `project:admin` is the write-capable project scope. It appears in the live
 *   discovery document's `scopes_supported` but is absent from the prose scope
 *   table in Railway's docs, which lists only viewer/member for projects.
 * - `workspace:viewer` is read-only, and is not optional despite sounding it. Railway
 *   scopes workspaces separately from projects, so without it `me.workspaces` is
 *   refused outright — which is exactly what broke the dashboard: the app asked for a
 *   field it had never been granted and treated the refusal as a total failure.
 */
export const SCOPES = [
  "openid",
  "email",
  "profile",
  "offline_access",
  "project:admin",
  "workspace:viewer",
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
