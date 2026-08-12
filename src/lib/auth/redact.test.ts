import { describe, expect, it } from "vitest";
import { describeOidcFailure } from "./redact";

/**
 * Canaries, not realistic values: an assertion that a token is absent is only worth
 * anything if the token is distinctive enough that a partial leak still trips it.
 */
const ACCESS = "AT-CANARY-9f3c";
const REFRESH = "RT-CANARY-71ab";

/** The exact shape oauth4webapi throws — build/index.js:1276 in 3.8.6. */
function unsupportedTokenType() {
  const error = new Error("unsupported `token_type` value", {
    cause: {
      body: {
        access_token: ACCESS,
        refresh_token: REFRESH,
        token_type: "mac",
        id_token: "eyJ.canary.token",
      },
    },
  });
  error.name = "UnsupportedOperationError";
  return error;
}

/** build/index.js:2343 — the decoded id_token, i.e. the user's identity. */
function unsupportedConfirmation() {
  const error = new Error("unsupported JWT Confirmation method", {
    cause: { claims: { sub: "user_canary", email: "ada@canary.example" } },
  });
  error.name = "UnsupportedOperationError";
  return error;
}

describe("describeOidcFailure", () => {
  it("drops the token response that openid-client attaches to cause", () => {
    // The whole reason this module exists: Railway retains stdout, so a credential
    // logged once outlives the request that leaked it.
    const line = describeOidcFailure(unsupportedTokenType());

    expect(line).not.toContain(ACCESS);
    expect(line).not.toContain(REFRESH);
    expect(line).not.toContain("eyJ");
  });

  it("drops the id_token claims, which are the user's identity", () => {
    const line = describeOidcFailure(unsupportedConfirmation());

    expect(line).not.toContain("ada@canary.example");
    expect(line).not.toContain("user_canary");
  });

  it("still says enough to diagnose the failure", () => {
    // A redactor that logs nothing is as useless as one that logs everything; the
    // signing-algorithm mismatch this replaced took a while to find precisely because
    // the reason was missing.
    const line = describeOidcFailure(unsupportedTokenType());

    expect(line).toContain("UnsupportedOperationError");
    expect(line).toContain("token_type");
  });

  it("keeps the OAuth error fields, which are not secret", () => {
    const line = describeOidcFailure({
      error: "invalid_client",
      error_description: "client authentication failed",
      status: 401,
    });

    expect(line).toContain("invalid_client");
    expect(line).toContain("HTTP 401");
    expect(line).toContain("client authentication failed");
  });

  it("reads only the allow-list, even from an object carrying more", () => {
    const line = describeOidcFailure({
      error: "invalid_grant",
      client_secret: "CS-CANARY",
      response: { access_token: ACCESS },
    });

    expect(line).toContain("invalid_grant");
    expect(line).not.toContain("CS-CANARY");
    expect(line).not.toContain(ACCESS);
  });

  it("handles a thrown non-object without stringifying an unknown shape", () => {
    expect(describeOidcFailure("boom")).toBe("boom");
    expect(describeOidcFailure(null)).toBe("null");
  });

  it("never returns an empty line", () => {
    expect(describeOidcFailure({})).toBe("unknown OIDC failure");
  });
});
