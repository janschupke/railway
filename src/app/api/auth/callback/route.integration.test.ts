import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
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
  });

  it("reports a failed token exchange without leaking the reason to the browser", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    authorizationCodeGrant.mockImplementation(async () => {
      throw new Error("invalid_client: bad secret");
    });

    const response = await GET(request("?code=abc&state=st"));

    expect(errorParam(response)).toBe("token_exchange_failed");
    expect(response.headers.get("location")).not.toContain("bad secret");
    // The reason has to reach the server log, or the failure is undiagnosable from
    // the outside — which is how an id_token alg mismatch once passed for a
    // redirect-URI problem.
    expect(logged).toHaveBeenCalledWith(
      "token exchange failed:",
      "Error: invalid_client: bad secret",
    );
    logged.mockRestore();
  });

  it("never writes the token response to the log, whatever openid-client attaches", async () => {
    /*
     * The assertion that matters, made over the real handler rather than the redactor
     * alone. oauth4webapi throws this exact shape when the token endpoint returns an
     * unrecognised `token_type` — and `cause.body` is the parsed response, holding a
     * live access and refresh token. Railway retains stdout, so one such line outlives
     * the request that produced it.
     *
     * Stringifying the whole call log, rather than matching an expected argument list,
     * is what makes this a real statement: it fails no matter which argument slot or
     * nested field a future edit puts the credential in.
     */
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
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

    const everythingLogged = JSON.stringify(logged.mock.calls);
    expect(everythingLogged).not.toContain("AT-CANARY");
    expect(everythingLogged).not.toContain("RT-CANARY");
    // …and the line is still there. Deleting the console.error would satisfy the two
    // assertions above and leave the failure undiagnosable.
    expect(everythingLogged).toContain("UnsupportedOperationError");

    logged.mockRestore();
  });

  it("logs the OAuth error body when the token endpoint rejects the request", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
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
    expect(logged).toHaveBeenCalledWith(
      "token exchange failed:",
      "Error: server responded with an error — invalid_grant · HTTP 400 · code is expired",
    );
    logged.mockRestore();
  });

  it("rejects a response with no identity claims", async () => {
    authorizationCodeGrant.mockResolvedValue(tokens({ claims: () => undefined }));

    expect(errorParam(await GET(request("?code=abc&state=st")))).toBe(
      "missing_id_token",
    );
  });

  it("refuses a session that would die in an hour", async () => {
    /*
     * Without a refresh token the session expires mid-use. Failing now with an
     * explanation beats failing later inside an action the user has already started.
     */
    authorizationCodeGrant.mockResolvedValue(tokens({ refresh_token: undefined }));

    const response = await GET(request("?code=abc&state=st"));

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
