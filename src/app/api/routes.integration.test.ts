import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetEnv } from "@/env";
import { logRecords, rawLogLines } from "@/test/log-capture";
import {
  CONSENT_COOKIE,
  PKCE_COOKIE,
  SESSION_COOKIE,
  STATE_COOKIE,
} from "@/lib/auth/session";
import { SESSION, STREAM } from "@/lib/constants";

const session = {
  user: { id: "u1", name: "Ada", email: "ada@example.com" },
  accessToken: "token",
  refreshToken: "refresh",
  expiresAt: 9_999_999_999,
  scope: "openid project:admin",
};
const requireSession = vi.fn(async () => session);
vi.mock("@/lib/auth/server", () => ({
  requireSession: () => requireSession(),
  requireAccessToken: async () => (await requireSession()).accessToken,
}));

const monitorDeployment = vi.fn();
vi.mock("@/lib/railway/deployment-monitor", () => ({
  monitorDeployment: (...args: unknown[]) => monitorDeployment(...args),
}));

const { GET: health } = await import("./health/route");
const { GET: login } = await import("./auth/login/route");
const { POST: logout } = await import("./auth/logout/route");
const { GET: stream } = await import("./streams/[deploymentId]/route");

const url = (path: string) => new URL(path, "http://localhost:3000");
const request = (path: string, headers?: Record<string, string>) =>
  new NextRequest(url(path), headers ? { headers } : undefined);

beforeEach(() => {
  requireSession.mockReset().mockResolvedValue(session);
  monitorDeployment.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/health", () => {
  it("reports ok without touching the Railway API", async () => {
    // A healthcheck that depends on an upstream would cycle this deployment during
    // an unrelated Railway incident.
    const response = health();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("names the misconfigured variables in the log, not in the response", async () => {
    // Unauthenticated endpoint: the issue list is a map of this deployment's env vars.
    vi.stubEnv("SESSION_SECRET", "too-short");
    __resetEnv();

    const response = health();

    expect(response.status).toBe(503);
    // toEqual, not toMatchObject: a future field that re-opens the leak must fail here.
    await expect(response.json()).resolves.toEqual({ status: "misconfigured" });
    expect(logRecords()).toContainEqual(
      expect.objectContaining({
        msg: "health.env_invalid",
        issues: expect.stringContaining("SESSION_SECRET"),
      }),
    );

    __resetEnv();
  });
});

describe("GET /api/auth/login", () => {
  it("redirects to Railway with PKCE and state", async () => {
    const response = await login(request("/api/auth/login"));

    expect(response.status).toBe(307);
    const target = new URL(response.headers.get("location")!);
    expect(target.origin + target.pathname).toBe(
      "https://backboard.railway.com/oauth/auth",
    );
    expect(target.searchParams.get("response_type")).toBe("code");
    expect(target.searchParams.get("code_challenge_method")).toBe("S256");
    expect(target.searchParams.get("code_challenge")).toBeTruthy();
    expect(target.searchParams.get("state")).toBeTruthy();
  });

  it("leaves the consent decision to Railway by default", async () => {
    // The whole point: once the grant exists Railway skips the screen. Forcing it here
    // is what made choosing projects again the price of every single sign-in.
    const response = await login(request("/api/auth/login"));

    const target = new URL(response.headers.get("location")!);
    expect(target.searchParams.get("prompt")).toBeNull();
    expect(response.cookies.get(CONSENT_COOKIE)?.value).toBeFalsy();
  });

  it("forces consent when asked, and records that it did", async () => {
    const response = await login(request("/api/auth/login?consent=1"));

    const target = new URL(response.headers.get("location")!);
    expect(target.searchParams.get("prompt")).toBe("consent");
    // The marker is what stops the callback's no-refresh-token retry from looping.
    expect(response.cookies.get(CONSENT_COOKIE)?.value).toBe("1");
  });

  it("requests the scopes the app cannot work without", async () => {
    const response = await login(request("/api/auth/login"));
    const scope = new URL(response.headers.get("location")!).searchParams.get("scope")!;

    expect(scope).toContain("openid");
    expect(scope).toContain("offline_access");
    expect(scope).toContain("project:admin");
    // Railway scopes workspaces separately; without this `me.workspaces` is refused.
    expect(scope).toContain("workspace:viewer");
  });

  it("stores the verifier and state in short-lived httpOnly cookies", async () => {
    const response = await login(request("/api/auth/login"));

    const pkce = response.cookies.get(PKCE_COOKIE);
    const state = response.cookies.get(STATE_COOKIE);
    expect(pkce?.httpOnly).toBe(true);
    expect(pkce?.maxAge).toBe(SESSION.TRANSIENT_MAX_AGE_SECONDS);
    expect(state?.value).toBeTruthy();
  });

  it("sends the code_challenge, never the verifier", async () => {
    const response = await login(request("/api/auth/login"));
    const target = new URL(response.headers.get("location")!);
    const verifier = response.cookies.get(PKCE_COOKIE)!.value;

    expect(target.searchParams.get("code_challenge")).not.toBe(verifier);
  });

  it("points the redirect_uri at this app's callback", async () => {
    const response = await login(request("/api/auth/login"));
    expect(
      new URL(response.headers.get("location")!).searchParams.get("redirect_uri"),
    ).toBe("http://localhost:3000/api/auth/callback");
  });
});

describe("POST /api/auth/logout", () => {
  const sameSite = { "sec-fetch-site": "same-origin" };

  it("clears the session and sends the browser home with a GET", async () => {
    const response = await logout(request("/api/auth/logout", sameSite));

    // 303 so the browser follows with GET rather than re-POSTing.
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3000/");
    // Asserted on the wire rather than through NextResponse.cookies: the refusal path
    // returns a plain Response, and this is what the browser actually acts on.
    expect(response.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=;`);
  });

  it("accepts a form POST identified by its Origin", async () => {
    // Safari has historically been late to Sec-Fetch-Site; Origin is the fallback and
    // the fetch spec requires a form submission to send it.
    const response = await logout(
      request("/api/auth/logout", { origin: "http://localhost:3000" }),
    );
    expect(response.status).toBe(303);
  });

  it("refuses a cross-site POST rather than signing the user out", async () => {
    const response = await logout(
      request("/api/auth/logout", { origin: "https://evil.test" }),
    );

    expect(response.status).toBe(403);
    // The point: no Set-Cookie at all, so a forged request cannot clear the session.
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("refuses a request that identifies itself with neither header", async () => {
    expect((await logout(request("/api/auth/logout"))).status).toBe(403);
  });

  it("records the rejection without echoing what the caller sent", async () => {
    /*
     * Every caller that reaches this line is by definition not a browser, so both
     * headers are whatever curl felt like sending — and they were being written straight
     * into the record. The diagnostic content is "was there an Origin, and did the
     * fetch metadata claim anything recognisable", which survives as a boolean and a
     * closed set.
     */
    await logout(
      request("/api/auth/logout", {
        origin: "https://ORIGIN-CANARY.test",
        "sec-fetch-site": "SITE-CANARY",
      }),
    );

    const everythingLogged = rawLogLines().join("");
    expect(everythingLogged).not.toContain("ORIGIN-CANARY");
    expect(everythingLogged).not.toContain("SITE-CANARY");
    expect(logRecords()).toContainEqual(
      expect.objectContaining({
        msg: "auth.logout.rejected",
        reason: "cross_origin",
        origin_present: true,
        sec_fetch_site: "other",
      }),
    );
  });
});

describe("GET /api/streams/[deploymentId]", () => {
  const params = (deploymentId: string) => ({
    params: Promise.resolve({ deploymentId }),
  });

  async function readEvents(response: Response): Promise<string> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    return out;
  }

  it("refuses an unauthenticated request", async () => {
    requireSession.mockImplementation(async () => {
      throw new Error("no session");
    });

    const response = await stream(request("/api/streams/dep_1"), params("dep_1"));

    expect(response.status).toBe(401);
    expect(monitorDeployment).not.toHaveBeenCalled();
  });

  it.each(["../../etc/passwd", "a".repeat(65), "dep 1", "dep/1", ""])(
    "rejects %j before doing any upstream work",
    async (id) => {
      /*
       * The identifier came off the URL and went straight to the GraphQL layer and an
       * upstream WebSocket. The assertion that matters is not the status code but that
       * nothing was spent: a rejected request must not reach the monitor at all.
       */
      const response = await stream(request(`/api/streams/${id}`), params(id));

      expect(response.status).toBe(400);
      expect(monitorDeployment).not.toHaveBeenCalled();
    },
  );

  it("refuses to open more concurrent streams than one user may hold", async () => {
    // Each stream costs a held response, an upstream socket and a recurring poll;
    // before the cap, one session could open as many as it liked.
    monitorDeployment.mockImplementation(
      () =>
        ({
          [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
        }) as AsyncIterable<never>,
    );

    const open = [];
    for (let i = 0; i < STREAM.MAX_CONCURRENT_PER_USER; i++) {
      open.push(await stream(request("/api/streams/dep_1"), params("dep_1")));
    }
    expect(open.every((r) => r.status === 200)).toBe(true);

    /*
     * The refusal is a 200 SSE carrying a named error, not a 429.
     *
     * A 429 is the honest HTTP answer, but EventSource exposes no status code — it
     * reaches the client as an unlabelled failure, indistinguishable from a 400 or a
     * dropped socket. This is the one refusal the reader can act on, so it gets a
     * sentence instead of silence.
     */
    const refused = await stream(request("/api/streams/dep_1"), params("dep_1"));
    expect(refused.status).toBe(200);
    expect(await readEvents(refused)).toContain("event: error");
    // Named, but still a refusal: no monitor, no upstream socket, no slot taken.
    expect(monitorDeployment).toHaveBeenCalledTimes(STREAM.MAX_CONCURRENT_PER_USER);

    // Releasing one frees exactly one slot — the counter is not one-way.
    await open[0]!.body!.cancel();
    await vi.waitFor(async () => {
      const retried = await stream(request("/api/streams/dep_1"), params("dep_1"));
      expect(retried.status).toBe(200);
      await retried.body!.cancel();
    });

    for (const response of open.slice(1)) await response.body!.cancel();
  });

  it("relays monitor events as SSE frames, in order, and stops at done", async () => {
    monitorDeployment.mockImplementation(async function* () {
      yield { type: "ready", deploymentId: "dep_1", phase: "deploy", backfilled: 0 };
      yield { type: "log", line: { timestamp: "t", message: "hello" } };
      yield {
        type: "status",
        deploymentId: "dep_1",
        state: "running",
        rawStatus: "SUCCESS",
      };
      yield { type: "done", deploymentId: "dep_1", state: "running" };
      yield { type: "log", line: { timestamp: "t", message: "after done" } };
    });

    const response = await stream(request("/api/streams/dep_1"), params("dep_1"));
    const body = await readEvents(response);

    expect(response.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(body.match(/event: (\w+)/g)).toEqual([
      "event: ready",
      "event: log",
      "event: status",
      "event: done",
    ]);
    // The event type is the SSE name; the rest is the payload.
    expect(body).toContain('data: {"line":{"timestamp":"t","message":"hello"}}');
    expect(body).not.toContain("after done");
  });

  it("ends the stream on a monitor error", async () => {
    monitorDeployment.mockImplementation(async function* () {
      yield { type: "error", message: "Authorization revoked" };
      yield { type: "log", line: { timestamp: "t", message: "unreachable" } };
    });

    const body = await readEvents(
      await stream(request("/api/streams/dep_1"), params("dep_1")),
    );

    expect(body).toContain("event: error");
    expect(body).not.toContain("unreachable");
  });

  it("defaults to the deploy phase and honours ?phase=build", async () => {
    monitorDeployment.mockImplementation(async function* () {});

    await stream(request("/api/streams/dep_1"), params("dep_1"));
    expect(monitorDeployment).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "deploy", deploymentId: "dep_1" }),
    );

    await stream(request("/api/streams/dep_1?phase=build"), params("dep_1"));
    expect(monitorDeployment).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "build" }),
    );
  });

  it("treats an unrecognised phase as deploy rather than failing", async () => {
    monitorDeployment.mockImplementation(async function* () {});

    await stream(request("/api/streams/dep_1?phase=nonsense"), params("dep_1"));

    expect(monitorDeployment).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "deploy" }),
    );
  });

  /*
   * Scoped to this block rather than the file. Every case above reads a real stream to
   * completion, and fake timers there would mean maintaining a manual clock for the
   * keepalive interval in tests that have nothing to say about it.
   */
  describe("with fake timers", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      // On a whole second, so the second that `expiresAt` truncates away is not the
      // difference between the assertion below passing and failing.
      vi.setSystemTime(Date.UTC(2026, 0, 1, 12, 0, 0));
    });
    afterEach(() => vi.useRealTimers());

    it("closes when its access token expires, not at the full ceiling", async () => {
      /*
       * The token is captured once, at open, and requireSession renews only inside
       * SESSION.REFRESH_SKEW_SECONDS — a third of STREAM.MAX_DURATION_MS. A stream that
       * opened just outside the skew therefore held an upstream socket and a 2.5s poll
       * for ten more minutes on a credential Railway had stopped accepting, and the log
       * pane it was feeding went quiet without saying why.
       */
      const lifetimeSeconds = SESSION.REFRESH_SKEW_SECONDS + 100;
      requireSession.mockResolvedValue({
        ...session,
        expiresAt: Math.floor(Date.now() / 1000) + lifetimeSeconds,
      });
      // A build that never finishes: the ceiling is the only thing that can end this.
      monitorDeployment.mockImplementation(
        () =>
          ({
            [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
          }) as AsyncIterable<never>,
      );

      const response = await stream(request("/api/streams/dep_1"), params("dep_1"));
      let ended = false;
      const body = readEvents(response).then(() => {
        ended = true;
      });

      await vi.advanceTimersByTimeAsync(lifetimeSeconds * 1000 - 1000);
      expect(ended).toBe(false);

      await vi.advanceTimersByTimeAsync(1000);
      await body;

      expect(ended).toBe(true);
      // `deadline`, and a duration short of MAX_DURATION_MS: the token bound it, and the
      // close line is where an operator can see which of the two did.
      expect(
        logRecords().find((record) => record.msg === "stream.closed"),
      ).toMatchObject({ reason: "deadline", duration_ms: lifetimeSeconds * 1000 });
      expect(lifetimeSeconds * 1000).toBeLessThan(STREAM.MAX_DURATION_MS);
    });
  });
});
