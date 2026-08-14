import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION } from "@/lib/constants";
import { logRecords, rawLogLines } from "@/test/log-capture";
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

const { proxy, config } = await import("./proxy");
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

async function request(
  path: string,
  sessionValue?: RailwaySession,
  headers?: Record<string, string>,
) {
  const req = new NextRequest(
    new URL(path, "http://localhost:3000"),
    headers ? { headers } : undefined,
  );
  if (sessionValue) {
    req.cookies.set(SESSION_COOKIE, await sealSession(sessionValue, SECRET));
  }
  return req;
}

/**
 * What Railway's edge puts in front of a request to the deployed app.
 *
 * A bare `new Request(url)` carries no Host, so every case that omits these is served as
 * the APP_URL fallback — http://localhost:3000 under test, where the cookie names are
 * unprefixed and `secure` is off.
 */
const deployed = {
  "x-forwarded-host": "trains.schupke.io",
  "x-forwarded-proto": "https",
};

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

    const req = await request("/", session({ expiresAt: now() - 1 }));
    const response = await proxy(req);

    expect(response.headers.get("location")).toBeNull();
    expect(response.cookies.get(SESSION_COOKIE)?.value).toBe("");
    /*
     * Cleared on the request too. Deleting it only on the response left this render
     * still holding a dead session, so the landing page redirected to /dashboard, which
     * redirected straight back — a bounce that showed the user nothing at all.
     */
    expect(req.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });

  it("keeps a session that another request refreshed while this one was losing", async () => {
    /*
     * The bug that manufactured re-authorizations. Refresh tokens rotate, so a request
     * that loses the race spends a token that has already been replaced — and this
     * branch then deleted the cookie holding the *successful* refresh, ending a session
     * that was perfectly alive.
     */
    const stale = session({ expiresAt: now() - 1 });
    const req = await request("/dashboard", stale);

    refreshSession.mockImplementation(async () => {
      // Stand in for the winning request: the jar now holds a newer session.
      req.cookies.set(
        SESSION_COOKIE,
        await sealSession(session({ expiresAt: now() + 3600 }), SECRET),
      );
      throw new SessionExpiredError("invalid_grant");
    });

    const response = await proxy(req);

    expect(response.headers.get("location")).toBeNull();
    expect(response.cookies.get(SESSION_COOKIE)?.value).not.toBe("");
    expect(
      await openSession(req.cookies.get(SESSION_COOKIE)?.value, SECRET),
    ).not.toBeNull();
  });

  it("treats an unreadable cookie as no session at all", async () => {
    const req = new NextRequest(new URL("/dashboard", "http://localhost:3000"));
    req.cookies.set(SESSION_COOKIE, "garbage");

    const response = await proxy(req);

    expect(response.status).toBe(307);
    expect(refreshSession).not.toHaveBeenCalled();
  });
});

describe("the origin the request arrived at", () => {
  it("reads and writes the cookie the served domain implies", async () => {
    /*
     * The proxy is the only refresh writer, so if it names the cookie from a configured
     * origin rather than the served one it looks for a session nobody set and rewrites it
     * under a name the browser will reject. Both halves are here: the sealed cookie is
     * presented under the `__Host-` name, and the refreshed one goes back under it.
     */
    const req = await request("/dashboard", undefined, deployed);
    req.cookies.set(
      `__Host-${SESSION_COOKIE}`,
      await sealSession(session({ expiresAt: now() + 10 }), SECRET),
    );
    refreshSession.mockResolvedValue(session({ accessToken: "fresh" }));

    const response = await proxy(req);

    const written = response.cookies.get(`__Host-${SESSION_COOKIE}`);
    expect(written?.secure).toBe(true);
    expect(await openSession(written?.value, SECRET)).toMatchObject({
      accessToken: "fresh",
    });
  });

  it("upgrades the policy on an https origin and not on a loopback one", async () => {
    // Derived from the request's own scheme now, which makes the directive a second,
    // independent readout of what origin this response was built for.
    const secure = await proxy(await request("/", session(), deployed));
    expect(secure.headers.get("content-security-policy")).toContain(
      "upgrade-insecure-requests",
    );

    const local = await proxy(await request("/", session()));
    expect(local.headers.get("content-security-policy")).not.toContain(
      "upgrade-insecure-requests",
    );
  });

  it("refuses a cleartext scheme on a public host, and names no host in the record", async () => {
    /*
     * Falls back to APP_URL here, because the test environment declares one. The 400 path
     * is the deployment that declares none — see routes.integration.test.ts, where the
     * auth routes take the same refusal.
     */
    const response = await proxy(
      await request("/", session(), {
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "http",
      }),
    );

    expect(response.status).toBe(200);
    expect(rawLogLines().join("")).not.toContain("evil.example");
    expect(logRecords()).toContainEqual(
      expect.objectContaining({
        msg: "request.origin_rejected",
        reason: "insecure",
        fell_back: true,
      }),
    );
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

describe("request id", () => {
  const ID = /^[0-9a-f]{16}$/;

  it("forwards one to the render and echoes it on the response", async () => {
    // The proxy and the render are separate invocations, so a header is the only channel
    // between them. Same transport as the nonce, observed the same way.
    const response = await proxy(await request("/", session()));

    const forwarded = response.headers.get("x-middleware-request-x-request-id");
    expect(forwarded).toMatch(ID);
    expect(response.headers.get("x-request-id")).toBe(forwarded);
  });

  it("mints a new one per request", async () => {
    const first = await proxy(await request("/", session()));
    const second = await proxy(await request("/", session()));

    expect(first.headers.get("x-request-id")).not.toBe(
      second.headers.get("x-request-id"),
    );
  });

  it("never adopts one the caller supplied", async () => {
    /*
     * An attacker-chosen id would put arbitrary bytes into a field operators grep, hand
     * Loki an unbounded label, and let a caller staple its requests onto someone else's
     * correlation chain. `headers.set` overwrites unconditionally; this proves it.
     */
    const req = await request("/", session());
    req.headers.set("x-request-id", "<script>alert(1)</script>");

    const response = await proxy(req);

    expect(response.headers.get("x-request-id")).toMatch(ID);
    expect(response.headers.get("x-middleware-request-x-request-id")).toMatch(ID);
  });

  it("carries one on a redirect, where there is no forwarded request to read", async () => {
    const response = await proxy(
      new NextRequest(new URL("/dashboard", "http://localhost:3000")),
    );

    expect(response.headers.get("x-request-id")).toMatch(ID);
  });
});

describe("config.matcher", () => {
  /*
   * Asserted as a regex against paths rather than by running the proxy, because what is
   * being tested is which requests reach it at all — a question Next answers before any
   * of this module's code runs, and therefore one no proxy() test can see.
   */
  const matches = (pathname: string) => {
    const [pattern] = config.matcher;
    return new RegExp(`^${pattern}$`).test(pathname);
  };

  it("covers the pages that need a session", () => {
    expect(matches("/dashboard")).toBe(true);
    expect(matches("/dashboard/anything")).toBe(true);
    expect(matches("/")).toBe(true);
  });

  it("skips the auth routes, which mint the session they would be gated by", () => {
    expect(matches("/api/auth/login")).toBe(false);
    expect(matches("/api/auth/callback")).toBe(false);
    expect(matches("/api/auth/logout")).toBe(false);
  });

  it("skips the healthcheck, so its own handler can answer", () => {
    /*
     * This was matched, and the proxy calls env() before anything else — so a
     * deployment with a bad SESSION_SECRET threw here and Railway's healthcheck saw a
     * bare 500, while the route written to report exactly that condition with a 503 and
     * a logged issue list was unreachable. The route's own tests never caught it: they
     * call the handler directly, where the proxy does not exist.
     */
    expect(matches("/api/health")).toBe(false);
  });

  it("skips static assets that would otherwise pay an HKDF derive each", () => {
    expect(matches("/_next/static/chunk.js")).toBe(false);
    expect(matches("/favicon.ico")).toBe(false);
    expect(matches("/icon.svg")).toBe(false);
  });

  it("still covers the routes that do need the session", () => {
    expect(matches("/api/streams/dep_1")).toBe(true);
    expect(matches("/api/watch/proj_1")).toBe(true);
  });
});
