import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PKCE_COOKIE, SESSION_COOKIE, STATE_COOKIE } from "@/lib/auth/session";
import { SESSION } from "@/lib/constants";

const requireAccessToken = vi.fn(async () => "token");
vi.mock("@/lib/auth/server", () => ({
  requireAccessToken: () => requireAccessToken(),
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
const request = (path: string) => new NextRequest(url(path));

beforeEach(() => {
  requireAccessToken.mockReset().mockResolvedValue("token");
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
});

describe("GET /api/auth/login", () => {
  it("redirects to Railway with PKCE, state and the consent prompt", async () => {
    const response = await login();

    expect(response.status).toBe(307);
    const target = new URL(response.headers.get("location")!);
    expect(target.origin + target.pathname).toBe(
      "https://backboard.railway.com/oauth/auth",
    );
    expect(target.searchParams.get("response_type")).toBe("code");
    expect(target.searchParams.get("code_challenge_method")).toBe("S256");
    expect(target.searchParams.get("code_challenge")).toBeTruthy();
    expect(target.searchParams.get("state")).toBeTruthy();
    // Without prompt=consent, offline_access may not yield a refresh token.
    expect(target.searchParams.get("prompt")).toBe("consent");
  });

  it("requests the scopes the app cannot work without", async () => {
    const response = await login();
    const scope = new URL(response.headers.get("location")!).searchParams.get("scope")!;

    expect(scope).toContain("openid");
    expect(scope).toContain("offline_access");
    expect(scope).toContain("project:admin");
  });

  it("stores the verifier and state in short-lived httpOnly cookies", async () => {
    const response = await login();

    const pkce = response.cookies.get(PKCE_COOKIE);
    const state = response.cookies.get(STATE_COOKIE);
    expect(pkce?.httpOnly).toBe(true);
    expect(pkce?.maxAge).toBe(SESSION.TRANSIENT_MAX_AGE_SECONDS);
    expect(state?.value).toBeTruthy();
  });

  it("sends the code_challenge, never the verifier", async () => {
    const response = await login();
    const target = new URL(response.headers.get("location")!);
    const verifier = response.cookies.get(PKCE_COOKIE)!.value;

    expect(target.searchParams.get("code_challenge")).not.toBe(verifier);
  });

  it("points the redirect_uri at this app's callback", async () => {
    const response = await login();
    expect(
      new URL(response.headers.get("location")!).searchParams.get("redirect_uri"),
    ).toBe("http://localhost:3000/api/auth/callback");
  });
});

describe("POST /api/auth/logout", () => {
  it("clears the session and sends the browser home with a GET", async () => {
    const response = await logout(request("/api/auth/logout"));

    // 303 so the browser follows with GET rather than re-POSTing.
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3000/");
    expect(response.cookies.get(SESSION_COOKIE)?.value).toBe("");
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
    requireAccessToken.mockImplementation(async () => {
      throw new Error("no session");
    });

    const response = await stream(request("/api/streams/dep_1"), params("dep_1"));

    expect(response.status).toBe(401);
    expect(monitorDeployment).not.toHaveBeenCalled();
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
});
