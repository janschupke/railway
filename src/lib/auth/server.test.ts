import { beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION } from "@/lib/constants";
import { sealSession, SESSION_COOKIE, type RailwaySession } from "./session";

const store = new Map<string, string>();
const jar = {
  get: (name: string) => {
    const value = store.get(name);
    return value === undefined ? undefined : { name, value };
  },
  // The third argument is the cookie options object; assertions read it off
  // mock.calls, so the signature has to accept it.
  set: vi.fn((...args: [string, string, Record<string, unknown>?]) =>
    store.set(args[0], args[1]),
  ),
  // No `delete`. The jar this stands in for has one, and using it is the defect
  // src/cookie-removal.test.ts bans; a mock without it turns a re-introduction into a
  // TypeError here as well as an offender there.
};
vi.mock("next/headers", () => ({ cookies: async () => jar }));

// ./refresh is deliberately not mocked: nothing in server.ts calls the grant any more.
// The proxy is the only refresh writer — see requireSession's doc comment.

const { getSession, persistSession, requireAccessToken, SessionExpiredError } =
  await import("./server");

const SECRET = process.env.SESSION_SECRET!;
const now = () => Math.floor(Date.now() / 1000);

const session = (over: Partial<RailwaySession> = {}): RailwaySession => ({
  user: { id: "u1", name: "Ada" },
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: now() + 3600,
  scope: "openid",
  ...over,
});

beforeEach(() => {
  store.clear();
  jar.set.mockClear();
});

describe("getSession", () => {
  it("returns null when no cookie is present", async () => {
    expect(await getSession()).toBeNull();
  });

  it("reads a sealed session back", async () => {
    store.set(SESSION_COOKIE, await sealSession(session(), SECRET));
    expect(await getSession()).toMatchObject({ accessToken: "access" });
  });

  it("returns null for a cookie it cannot open", async () => {
    store.set(SESSION_COOKIE, "not-a-jwe");
    expect(await getSession()).toBeNull();
  });

  it("does not refresh, because a Server Component cannot write the result back", async () => {
    // The read side of the contract with proxy.ts. Refreshing here would rotate the
    // refresh token and then lose it, stranding the session.
    store.set(
      SESSION_COOKIE,
      await sealSession(session({ expiresAt: now() - 1 }), SECRET),
    );

    await getSession();

    expect(jar.set).not.toHaveBeenCalled();
  });
});

describe("persistSession", () => {
  it("writes an httpOnly cookie with the session lifetime", async () => {
    await persistSession(session());

    const [name, , options] = jar.set.mock.calls[0]!;
    expect(name).toBe(SESSION_COOKIE);
    expect(options).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      maxAge: SESSION.MAX_AGE_SECONDS,
    });
  });

  it("stores the tokens encrypted, never in the clear", async () => {
    await persistSession(session({ accessToken: "super-secret-token" }));
    const [, value] = jar.set.mock.calls[0]!;
    expect(value).not.toContain("super-secret-token");
  });

  it("marks the cookie secure only on https origins", async () => {
    // APP_URL is http://localhost:3000 under test, where Secure would break sign-in.
    await persistSession(session());
    const [, , options] = jar.set.mock.calls[0]!;
    expect(options).toMatchObject({ secure: false });
  });
});

describe("requireAccessToken", () => {
  it("throws when there is no session", async () => {
    await expect(requireAccessToken()).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it("returns the current token when it is still fresh", async () => {
    store.set(SESSION_COOKIE, await sealSession(session(), SECRET));

    expect(await requireAccessToken()).toBe("access");
    expect(jar.set).not.toHaveBeenCalled();
  });

  it("uses a token inside the refresh window rather than refreshing it here", async () => {
    /*
     * The proxy is the only refresh writer: it runs before every path that reaches this
     * function, and its dedupe map is not the one this bundle would see. A token inside
     * REFRESH_SKEW_SECONDS still works, so this hands it over and lets the proxy rotate
     * it on the next request.
     */
    const stale = session({
      accessToken: "nearly-stale",
      expiresAt: now() + SESSION.REFRESH_SKEW_SECONDS - 10,
    });
    store.set(SESSION_COOKIE, await sealSession(stale, SECRET));

    expect(await requireAccessToken()).toBe("nearly-stale");
    expect(jar.set).not.toHaveBeenCalled();
  });

  it("refuses a token that has actually expired, so the caller can prompt re-consent", async () => {
    store.set(
      SESSION_COOKIE,
      await sealSession(session({ expiresAt: now() - 1 }), SECRET),
    );

    await expect(requireAccessToken()).rejects.toBeInstanceOf(SessionExpiredError);
    expect(jar.set).not.toHaveBeenCalled();
  });
});
