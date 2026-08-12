import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from "jose";
import type { Store } from "./store";

/**
 * A real OpenID Connect provider, in about 120 lines.
 *
 * The id_token is genuinely signed with ES256 — the algorithm real Railway uses — and
 * served through a real JWKS, so openid-client performs full signature and claim
 * validation against it. That is the point of this fixture over a session-seeding
 * shortcut: the PKCE round trip, the token exchange, and refresh-token rotation are all
 * exercised by the E2E suite instead of being stubbed away.
 *
 * The algorithm has to match production. oauth4webapi defaults to requiring RS256, so an
 * RS256 fixture would agree with that default and quietly pass while real sign-ins fail.
 */

const USER = {
  sub: "user_e2e",
  name: "Ada Lovelace",
  email: "ada@example.com",
};

type Keys = { privateKey: CryptoKey; jwks: { keys: unknown[] } };

let keys: Keys | undefined;

export async function getKeys(): Promise<Keys> {
  if (keys) return keys;
  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  jwk.kid = "fixture-key";
  jwk.alg = "ES256";
  jwk.use = "sig";
  keys = { privateKey, jwks: { keys: [jwk] } };
  return keys;
}

/** code -> the PKCE challenge it was issued against. */
const codes = new Map<string, { challenge: string; redirectUri: string }>();
/** Live refresh tokens. Rotation invalidates the previous one, as Railway does. */
const refreshTokens = new Set<string>();

/**
 * Grant counters, exposed at /__test/stats.
 *
 * Token refresh happens server-side, between Next and this fixture, so the browser
 * never issues that request and Playwright cannot observe it directly. Counting here
 * is how a spec proves a refresh actually occurred.
 */
export const stats = { authorizationCode: 0, refreshToken: 0, refreshRejected: 0 };

let seq = 0;
const nextId = (prefix: string) => `${prefix}_${(seq += 1)}`;

export function discoveryDocument(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/auth`,
    token_endpoint: `${issuer}/oauth/token`,
    userinfo_endpoint: `${issuer}/oauth/me`,
    jwks_uri: `${issuer}/oauth/jwks`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    scopes_supported: [
      "openid",
      "email",
      "profile",
      "offline_access",
      "project:admin",
      "project:member",
      "project:viewer",
      "workspace:admin",
      "workspace:member",
      "workspace:viewer",
    ],
    code_challenge_methods_supported: ["S256"],
    id_token_signing_alg_values_supported: ["ES256"],
    subject_types_supported: ["public"],
  };
}

/**
 * Consent is auto-approved and redirects straight back. A real consent screen would
 * add nothing the app's own code is responsible for.
 */
export function authorize(url: URL): { location: string } | { error: string } {
  const redirectUri = url.searchParams.get("redirect_uri");
  const state = url.searchParams.get("state");
  const challenge = url.searchParams.get("code_challenge");

  if (!redirectUri || !state) return { error: "invalid_request" };
  if (!challenge || url.searchParams.get("code_challenge_method") !== "S256") {
    // The app must always use PKCE; failing loudly here catches a regression.
    return { error: "pkce_required" };
  }

  const code = nextId("code");
  codes.set(code, { challenge, redirectUri });

  const location = new URL(redirectUri);
  location.searchParams.set("code", code);
  location.searchParams.set("state", state);
  return { location: location.href };
}

async function base64UrlSha256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Buffer.from(digest).toString("base64url");
}

async function idToken(issuer: string, clientId: string): Promise<string> {
  const { privateKey } = await getKeys();
  return new SignJWT({ ...USER, email_verified: true })
    .setProtectedHeader({ alg: "ES256", kid: "fixture-key" })
    .setIssuer(issuer)
    .setAudience(clientId)
    .setSubject(USER.sub)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

export type TokenResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; body: Record<string, unknown> };

export async function token(
  params: URLSearchParams,
  context: { issuer: string; clientId: string; store: Store },
): Promise<TokenResult> {
  const grantType = params.get("grant_type");
  const ttl = context.store.faults.accessTokenTtl;

  const issue = async (): Promise<TokenResult> => {
    const refresh = nextId("refresh");
    refreshTokens.add(refresh);
    return {
      ok: true,
      body: {
        access_token: nextId("access"),
        refresh_token: refresh,
        id_token: await idToken(context.issuer, context.clientId),
        token_type: "Bearer",
        expires_in: ttl,
        scope: "openid email profile offline_access project:admin",
      },
    };
  };

  if (grantType === "authorization_code") {
    const code = params.get("code") ?? "";
    const verifier = params.get("code_verifier");
    const record = codes.get(code);
    if (!record) return { ok: false, status: 400, body: { error: "invalid_grant" } };
    codes.delete(code);

    // Verify PKCE properly — a fixture that skips this would hide a real regression.
    if (!verifier || (await base64UrlSha256(verifier)) !== record.challenge) {
      return { ok: false, status: 400, body: { error: "invalid_grant" } };
    }
    stats.authorizationCode += 1;
    return issue();
  }

  if (grantType === "refresh_token") {
    const presented = params.get("refresh_token") ?? "";
    if (context.store.faults.refreshFails || !refreshTokens.has(presented)) {
      stats.refreshRejected += 1;
      return { ok: false, status: 400, body: { error: "invalid_grant" } };
    }
    // Rotation: the presented token is spent.
    refreshTokens.delete(presented);
    stats.refreshToken += 1;
    return issue();
  }

  return { ok: false, status: 400, body: { error: "unsupported_grant_type" } };
}

export const userinfo = () => USER;

export function resetOidc() {
  codes.clear();
  refreshTokens.clear();
  stats.authorizationCode = 0;
  stats.refreshToken = 0;
  stats.refreshRejected = 0;
}
