import { describe, expect, it } from "vitest";
import { RAILWAY_DEFAULTS } from "@/env";
import {
  SCOPES,
  discoveryUrl,
  oidcConfig,
  railwayMetadata,
  __resetOidcConfig,
} from "./oidc";

describe("railwayMetadata", () => {
  it("derives every endpoint from the issuer", () => {
    // All five live under /oauth even though the issuer is the bare domain — the
    // mismatch is why discovery cannot be used directly.
    expect(railwayMetadata(RAILWAY_DEFAULTS.ISSUER)).toMatchObject({
      issuer: "https://backboard.railway.com",
      authorization_endpoint: "https://backboard.railway.com/oauth/auth",
      token_endpoint: "https://backboard.railway.com/oauth/token",
      userinfo_endpoint: "https://backboard.railway.com/oauth/me",
      jwks_uri: "https://backboard.railway.com/oauth/jwks",
    });
  });

  it("follows a fixture issuer, which is what makes the E2E suite possible", () => {
    expect(railwayMetadata("http://localhost:4010").token_endpoint).toBe(
      "http://localhost:4010/oauth/token",
    );
  });

  it("advertises only PKCE S256", () => {
    expect(
      railwayMetadata(RAILWAY_DEFAULTS.ISSUER).code_challenge_methods_supported,
    ).toEqual(["S256"]);
  });
});

describe("discoveryUrl", () => {
  it("points at the /oauth-scoped document, not the domain root", () => {
    // The domain root 404s; getting this wrong breaks pnpm verify:schema silently.
    expect(discoveryUrl(RAILWAY_DEFAULTS.ISSUER)).toBe(
      "https://backboard.railway.com/oauth/.well-known/openid-configuration",
    );
  });
});

describe("SCOPES", () => {
  it("requests offline access, without which the session dies in an hour", () => {
    expect(SCOPES).toContain("offline_access");
  });

  it("requests the write-capable project scope", () => {
    // project:admin is absent from Railway's prose scope table but present in the
    // live discovery document; nothing can be created or destroyed without it.
    expect(SCOPES).toContain("project:admin");
  });

  it("includes openid, which the spec requires", () => {
    expect(SCOPES).toContain("openid");
  });
});

describe("oidcConfig", () => {
  it("memoises so every request shares one client", () => {
    __resetOidcConfig();
    expect(oidcConfig()).toBe(oidcConfig());
  });

  it("is rebuilt after a reset", () => {
    const first = oidcConfig();
    __resetOidcConfig();
    expect(oidcConfig()).not.toBe(first);
  });
});
