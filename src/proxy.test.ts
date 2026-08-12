import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION } from "@/lib/constants";
import {
  openSession,
  sealSession,
  SESSION_COOKIE,
  type RailwaySession,
} from "@/lib/auth/session";

const refreshSession = vi.fn();
vi.mock("@/lib/auth/refresh", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/refresh")>();
  return { ...actual, refreshSession: (s: RailwaySession) => refreshSession(s) };
});

const { proxy } = await import("./proxy");
const { SessionExpiredError } = await import("@/lib/auth/refresh");

const SECRET = process.env.SESSION_SECRET!;
const now = () => Math.floor(Date.now() / 1000);

const session = (over: Partial<RailwaySession> = {}): RailwaySession => ({
  user: { id: "u1" },
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: now() + 3600,
  scope: "openid",
  ...over,
});

async function request(path: string, sessionValue?: RailwaySession) {
  const req = new NextRequest(new URL(path, "http://localhost:3000"));
  if (sessionValue) {
    req.cookies.set(SESSION_COOKIE, await sealSession(sessionValue, SECRET));
  }
  return req;
}

// Braces matter: mockReset() returns the mock, and a beforeEach hook that returns a
// function has that function invoked as teardown — calling the mock a second time.
beforeEach(() => {
  refreshSession.mockReset();
});

describe("proxy", () => {
  it("sends an anonymous visitor away from a protected route", async () => {
    const response = await proxy(await request("/dashboard"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3000/");
  });

  it("leaves public routes alone when there is no session", async () => {
    const response = await proxy(await request("/"));
    expect(response.headers.get("location")).toBeNull();
  });

  it("passes a fresh session straight through", async () => {
    const response = await proxy(await request("/dashboard", session()));

    expect(refreshSession).not.toHaveBeenCalled();
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });

  it("refreshes ahead of the render and sets the cookie on request and response", async () => {
    /*
     * The heart of the token story: the render that triggered the refresh must see
     * the new token, which only works if it is written to the *request* too.
     */
    const rotated = session({ accessToken: "rotated", refreshToken: "next-refresh" });
    refreshSession.mockResolvedValue(rotated);

    const req = await request(
      "/dashboard",
      session({ expiresAt: now() + SESSION.REFRESH_SKEW_SECONDS - 10 }),
    );
    const response = await proxy(req);

    const onRequest = await openSession(req.cookies.get(SESSION_COOKIE)?.value, SECRET);
    expect(onRequest?.accessToken).toBe("rotated");

    const onResponse = await openSession(
      response.cookies.get(SESSION_COOKIE)?.value,
      SECRET,
    );
    expect(onResponse?.accessToken).toBe("rotated");
    expect(onResponse?.refreshToken).toBe("next-refresh");
  });

  it("also refreshes on public routes, so sign-out state stays accurate", async () => {
    refreshSession.mockResolvedValue(session({ accessToken: "rotated" }));

    const response = await proxy(await request("/", session({ expiresAt: now() - 1 })));

    expect(refreshSession).toHaveBeenCalled();
    expect(response.headers.get("location")).toBeNull();
  });

  it("clears the session and explains itself when the refresh token is spent", async () => {
    refreshSession.mockImplementation(async () => {
      throw new SessionExpiredError("invalid_grant");
    });

    const response = await proxy(
      await request("/dashboard", session({ expiresAt: now() - 1 })),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/?error=session_expired",
    );
    expect(response.cookies.get(SESSION_COOKIE)?.value).toBe("");
  });

  it("does not redirect a public route when refresh fails, only clears", async () => {
    refreshSession.mockImplementation(async () => {
      throw new SessionExpiredError();
    });

    const response = await proxy(await request("/", session({ expiresAt: now() - 1 })));

    expect(response.headers.get("location")).toBeNull();
    expect(response.cookies.get(SESSION_COOKIE)?.value).toBe("");
  });

  it("treats an unreadable cookie as no session at all", async () => {
    const req = new NextRequest(new URL("/dashboard", "http://localhost:3000"));
    req.cookies.set(SESSION_COOKIE, "garbage");

    const response = await proxy(req);

    expect(response.status).toBe(307);
    expect(refreshSession).not.toHaveBeenCalled();
  });
});

describe("content security policy", () => {
  const nonceOf = (policy: string | null) =>
    /'nonce-([A-Za-z0-9+/]+={0,2})'/.exec(policy ?? "")?.[1];

  it("sets a policy on a plain pass-through", async () => {
    const response = await proxy(await request("/", session()));
    const policy = response.headers.get("content-security-policy");

    expect(policy).toContain("frame-ancestors 'none'");
    expect(nonceOf(policy)).toBeDefined();
  });

  it("hands Next the same nonce it puts in the response policy", async () => {
    /*
     * The wiring that makes the whole thing work, and the part that fails invisibly:
     * Next parses the nonce out of the *request* CSP header and stamps it onto the
     * scripts it injects. NextResponse.next({ request }) transports request headers as
     * `x-middleware-request-*`, so that is where the override is observable from here.
     */
    const response = await proxy(await request("/", session()));

    const sent = nonceOf(response.headers.get("content-security-policy"));
    const forwarded = nonceOf(
      response.headers.get("x-middleware-request-content-security-policy"),
    );

    expect(forwarded).toBe(sent);
    expect(response.headers.get("x-middleware-request-x-nonce")).toBe(sent);
  });

  it("mints a new nonce per request", async () => {
    const first = await proxy(await request("/", session()));
    const second = await proxy(await request("/", session()));

    expect(nonceOf(first.headers.get("content-security-policy"))).not.toBe(
      nonceOf(second.headers.get("content-security-policy")),
    );
  });

  it("applies to a redirect too, so no branch is left uncovered", async () => {
    const response = await proxy(
      new NextRequest(new URL("/dashboard", "http://localhost:3000")),
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("content-security-policy")).toContain("default-src");
  });
});
