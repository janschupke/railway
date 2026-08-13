import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { logRecords, rawLogLines } from "@/test/log-capture";
import {
  CONSENT_COOKIE,
  openSession,
  PKCE_COOKIE,
  SESSION_COOKIE,
  STATE_COOKIE,
} from "@/lib/auth/session";

const authorizationCodeGrant = vi.fn();
vi.mock("openid-client", () => ({
  authorizationCodeGrant: (...args: unknown[]) => authorizationCodeGrant(...args),
}));
vi.mock("@/lib/auth/oidc", () => ({ oidcConfig: () => ({}) }));

const { GET } = await import("./route");

const SECRET = process.env.SESSION_SECRET!;

function request(
  query: string,
  cookies: Record<string, string> = { [PKCE_COOKIE]: "verifier", [STATE_COOKIE]: "st" },
) {
  const req = new NextRequest(
    new URL(`/api/auth/callback${query}`, "http://localhost:3000"),
  );
  for (const [name, value] of Object.entries(cookies)) req.cookies.set(name, value);
  return req;
}

const tokens = (over: Record<string, unknown> = {}) => ({
  access_token: "access",
  refresh_token: "refresh",
  expires_in: 3600,
  scope: "openid project:admin",
  claims: () => ({
    sub: "u1",
    name: "Ada",
    email: "ada@example.com",
    picture: "https://example.com/a.png",
  }),
  ...over,
});

const errorParam = (response: Response) =>
  new URL(response.headers.get("location")!).searchParams.get("error");

beforeEach(() => {
  authorizationCodeGrant.mockReset();
  authorizationCodeGrant.mockResolvedValue(tokens());
});

describe("GET /api/auth/callback", () => {
  it("mints a session and lands on the dashboard", async () => {
    const response = await GET(request("?code=abc&state=st"));

    expect(response.headers.get("location")).toBe("http://localhost:3000/dashboard");

    const session = await openSession(
      response.cookies.get(SESSION_COOKIE)?.value,
      SECRET,
    );
    expect(session).toMatchObject({
      accessToken: "access",
      refreshToken: "refresh",
      user: { id: "u1", name: "Ada", email: "ada@example.com" },
    });
  });

  it("clears the single-use PKCE and state cookies", async () => {
    const response = await GET(request("?code=abc&state=st"));

    expect(response.cookies.get(PKCE_COOKIE)?.value).toBe("");
    expect(response.cookies.get(STATE_COOKIE)?.value).toBe("");
  });

  it("passes the stored verifier and expected state to the exchange", async () => {
    // Dropping either turns the flow into an unprotected authorization-code grant.
    await GET(request("?code=abc&state=st"));

    expect(authorizationCodeGrant).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(URL),
      { pkceCodeVerifier: "verifier", expectedState: "st" },
    );
  });

  it("rebuilds the callback URL from APP_URL, not the proxied request host", async () => {
    // Behind Railway's proxy the incoming URL carries an internal host, which would
    // not match the registered redirect_uri.
    await GET(request("?code=abc&state=st"));

    const currentUrl = authorizationCodeGrant.mock.calls[0]?.[1] as URL;
    expect(currentUrl.origin).toBe("http://localhost:3000");
    expect(currentUrl.pathname).toBe("/api/auth/callback");
    expect(currentUrl.searchParams.get("code")).toBe("abc");
  });

  it("refuses a callback with no stored PKCE verifier", async () => {
    const response = await GET(request("?code=abc&state=st", {}));

    expect(errorParam(response)).toBe("missing_pkce_state");
    expect(authorizationCodeGrant).not.toHaveBeenCalled();
  });

  it("passes a declined consent back to the landing page", async () => {
    const response = await GET(request("?error=access_denied&state=st"));
    expect(errorParam(response)).toBe("access_denied");
    expect(logRecords()).toContainEqual(
      expect.objectContaining({ msg: "auth.callback.failed", reason: "access_denied" }),
    );
  });

  it("does not write an invented error code into the log", async () => {
    /*
     * `?error=` is a query parameter anyone can construct, and it was going into
     * `reason` verbatim — the field an operator groups on. That is the same unbounded,
     * attacker-chosen cardinality the rejected deploymentId is deliberately kept out of,
     * and here it also lands in a record retained past the request.
     *
     * The canary covers the log as bytes, not just the parsed record: the point is that
     * the string never appears anywhere in the line, however it got serialised.
     */
    const invented = `not_a_real_code_${"X".repeat(200)}`;
    const response = await GET(request(`?error=${invented}&state=st`));

    expect(rawLogLines().join("")).not.toContain("not_a_real_code");
    expect(logRecords()).toContainEqual(
      expect.objectContaining({
        msg: "auth.callback.failed",
        reason: "provider_error",
      }),
    );
    // The user still lands somewhere that explains itself; the page renders any code it
    // does not know as the same sentence, so classifying costs nothing on screen.
    expect(errorParam(response)).toBe("provider_error");
  });

  it("reports a failed token exchange without leaking the reason to the browser", async () => {
    authorizationCodeGrant.mockImplementation(async () => {
      throw new Error("invalid_client: bad secret");
    });

    const response = await GET(request("?code=abc&state=st"));

    expect(errorParam(response)).toBe("token_exchange_failed");
    expect(response.headers.get("location")).not.toContain("bad secret");
    // The reason has to reach the server log, or the failure is undiagnosable from
    // the outside — which is how an id_token alg mismatch once passed for a
    // redirect-URI problem.
    expect(logRecords()).toContainEqual(
      expect.objectContaining({
        msg: "auth.callback.token_exchange_failed",
        reason: "Error: invalid_client: bad secret",
      }),
    );
  });

  it("never writes the token response to the log, whatever openid-client attaches", async () => {
    /*
     * The assertion that matters, made over the real handler rather than the redactor
     * alone. oauth4webapi throws this exact shape when the token endpoint returns an
     * unrecognised `token_type` — and `cause.body` is the parsed response, holding a
     * live access and refresh token. Railway retains stdout, so one such line outlives
     * the request that produced it.
     *
     * Searching the raw written bytes, rather than matching an expected record shape, is
     * what makes this a real statement: it fails no matter which field or nested key a
     * future edit puts the credential in, and it reads what was actually serialized
     * rather than what a parser was willing to give back.
     */
    authorizationCodeGrant.mockImplementation(async () => {
      const error = new Error("unsupported `token_type` value", {
        cause: { body: { access_token: "AT-CANARY", refresh_token: "RT-CANARY" } },
      });
      error.name = "UnsupportedOperationError";
      throw error;
    });

    expect(errorParam(await GET(request("?code=abc&state=st")))).toBe(
      "token_exchange_failed",
    );

    const everythingLogged = rawLogLines().join("");
    expect(everythingLogged).not.toContain("AT-CANARY");
    expect(everythingLogged).not.toContain("RT-CANARY");
    // …and the line is still there. Deleting the log call would satisfy the two
    // assertions above and leave the failure undiagnosable.
    expect(everythingLogged).toContain("UnsupportedOperationError");
  });

  it("logs the OAuth error body when the token endpoint rejects the request", async () => {
    authorizationCodeGrant.mockImplementation(async () => {
      throw Object.assign(new Error("server responded with an error"), {
        error: "invalid_grant",
        error_description: "code is expired",
        status: 400,
      });
    });

    expect(errorParam(await GET(request("?code=abc&state=st")))).toBe(
      "token_exchange_failed",
    );
    expect(logRecords()).toContainEqual(
      expect.objectContaining({
        msg: "auth.callback.token_exchange_failed",
        reason:
          "Error: server responded with an error — invalid_grant · HTTP 400 · code is expired",
      }),
    );
  });

  it("rejects a response with no identity claims", async () => {
    authorizationCodeGrant.mockResolvedValue(tokens({ claims: () => undefined }));

    expect(errorParam(await GET(request("?code=abc&state=st")))).toBe(
      "missing_id_token",
    );
  });

  it("retries with consent forced when no refresh token came back", async () => {
    /*
     * Railway mints a refresh token on the flow where consent is granted, so a silent
     * authorization can legitimately return none. Sending the user to an error page
     * that says "sign in again and approve offline access" was a dead end: the retry
     * they were told to perform was byte-for-byte the request that had just failed.
     */
    authorizationCodeGrant.mockResolvedValue(tokens({ refresh_token: undefined }));

    const response = await GET(request("?code=abc&state=st"));

    expect(new URL(response.headers.get("location")!).pathname).toBe("/api/auth/login");
    expect(new URL(response.headers.get("location")!).searchParams.get("consent")).toBe(
      "1",
    );
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });

  it("gives up once consent has already been shown", async () => {
    // The retry happens once. If Railway withheld the token even with the consent
    // screen displayed, there is nothing left to try and looping would be the bug.
    authorizationCodeGrant.mockResolvedValue(tokens({ refresh_token: undefined }));

    const response = await GET(
      request("?code=abc&state=st", {
        [PKCE_COOKIE]: "verifier",
        [STATE_COOKIE]: "st",
        [CONSENT_COOKIE]: "1",
      }),
    );

    expect(errorParam(response)).toBe("no_refresh_token");
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });

  it("tolerates an id_token with only a subject", async () => {
    authorizationCodeGrant.mockResolvedValue(tokens({ claims: () => ({ sub: "u1" }) }));

    const response = await GET(request("?code=abc&state=st"));
    const session = await openSession(
      response.cookies.get(SESSION_COOKIE)?.value,
      SECRET,
    );

    expect(session?.user).toEqual({
      id: "u1",
      name: undefined,
      email: undefined,
      image: undefined,
    });
  });

  it("defaults the lifetime when expires_in is absent", async () => {
    authorizationCodeGrant.mockResolvedValue(tokens({ expires_in: undefined }));

    const response = await GET(request("?code=abc&state=st"));
    const session = await openSession(
      response.cookies.get(SESSION_COOKIE)?.value,
      SECRET,
    );

    const now = Math.floor(Date.now() / 1000);
    expect(session!.expiresAt).toBeGreaterThan(now + 3500);
    expect(session!.expiresAt).toBeLessThanOrEqual(now + 3600);
  });
});
