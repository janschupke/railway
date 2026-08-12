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
