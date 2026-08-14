import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logRecords, rawLogLines } from "@/test/log-capture";
import { __resetEnv } from "./env";
import { onRequestError, register } from "./instrumentation";

/** The two Next supplies beyond the error itself; only their shape matters here. */
const request = (path: string) => ({ path, method: "GET", headers: {} });
const context = {
  routerKind: "App Router" as const,
  routePath: "/dashboard",
  routeType: "render" as const,
  renderSource: "react-server-components" as const,
  revalidateReason: undefined,
  renderType: "dynamic" as const,
};

describe("onRequestError", () => {
  beforeEach(() => vi.clearAllMocks());

  it("records the digest, which is what the reference on screen refers to", () => {
    // Without this field the digest shown to the user joins to nothing.
    const error = Object.assign(new Error("render blew up"), { digest: "3141592" });

    onRequestError(error, request("/dashboard"), context);

    expect(logRecords()).toContainEqual(
      expect.objectContaining({
        msg: "render.failed",
        level: "error",
        digest: "3141592",
        route_group: "/dashboard",
      }),
    );
  });

  it("drops a browser that navigated away to debug", () => {
    /*
     * Next reports an abandoned render through the same hook as a genuine throw. At
     * `error` it fires on ordinary fast navigation, which is the false positive that
     * teaches people to ignore the level.
     */
    onRequestError(
      new Error("The destination stream closed early."),
      request("/dashboard"),
      context,
    );

    expect(logRecords()).toContainEqual(
      expect.objectContaining({ msg: "render.failed", level: "debug" }),
    );
  });

  it("groups the path instead of echoing it", () => {
    /*
     * `request.path` is the concrete URL path, chosen by whoever sent it. A 404 sweep
     * across /aaa, /aab, /aac wrote a new value per request into a field whose entire
     * purpose is to be grouped on — and Next's context carries no matched route pattern
     * to use instead.
     */
    onRequestError(new Error("boom"), request("/aaa-CANARY/bbb?q=CANARY"), context);
    onRequestError(new Error("boom"), request("/api/streams/dep_CANARY"), context);
    onRequestError(new Error("boom"), request("/"), context);

    const groups = logRecords()
      .filter((r) => r.msg === "render.failed")
      .map((r) => r.route_group);

    expect(groups).toEqual(["other", "/api", "/"]);
    expect(rawLogLines().join("")).not.toContain("CANARY");
  });
});

describe("register", () => {
  const restore = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...restore, NEXT_RUNTIME: "nodejs" };
    // env() memoises its first successful parse, so without this the second case in
    // this block reads the first case's environment rather than its own.
    __resetEnv();
  });

  afterEach(() => {
    process.env = restore;
  });

  const validEnv = () => {
    process.env.RAILWAY_CLIENT_ID = "id";
    process.env.RAILWAY_CLIENT_SECRET = "secret";
    process.env.SESSION_SECRET = "a-session-secret-of-at-least-32-chars";
    process.env.APP_URL = "https://example.test";
  };

  it("says the address it came up on, so a healthcheck aimed elsewhere is visible", () => {
    /*
     * A healthcheck failure cannot tell an app that never started from one that came up
     * where nothing is asking. Both halves of "where" are reported because the standalone
     * server reads both — under `next start` the address was an environment variable
     * nothing consulted, and a field for it would have been an invention.
     */
    validEnv();
    process.env.PORT = "8080";
    process.env.HOSTNAME = "::";

    register();

    expect(logRecords().find((r) => r.msg === "boot")).toMatchObject({
      port: "8080",
      hostname: "::",
    });
  });

  it("reports the address it fell back to, which is the one that cannot route", () => {
    /*
     * server.js defaults HOSTNAME to `0.0.0.0` — the IPv4 wildcard and no IPv6 interface,
     * which Railway's internal network needs. The Dockerfile sets `::`, so this value in a
     * deployed log means that line was lost rather than that nothing was configured.
     */
    validEnv();
    delete process.env.PORT;
    delete process.env.HOSTNAME;

    register();

    expect(logRecords().find((r) => r.msg === "boot")).toMatchObject({
      port: "3000",
      hostname: "0.0.0.0",
    });
  });

  it("names the variables a misconfigured deployment is missing", () => {
    // /api/health answers 503 for this, which is correct and indistinguishable from a
    // dead container in a platform dashboard. This is the line that tells them apart.
    delete process.env.SESSION_SECRET;
    process.env.RAILWAY_CLIENT_ID = "id";
    process.env.RAILWAY_CLIENT_SECRET = "secret";
    process.env.APP_URL = "https://example.test";

    register();

    const record = logRecords().find((r) => r.msg === "boot.env_invalid");
    expect(record).toBeDefined();
    expect(record).toMatchObject({ level: "error" });
    expect(String(record!.issues)).toContain("SESSION_SECRET");
  });

  it("does not throw a misconfigured deployment into a restart loop", () => {
    // Throwing here kills the boot, which loses this log to the crash and stops
    // /api/health reporting `misconfigured` at all.
    delete process.env.SESSION_SECRET;
    expect(() => register()).not.toThrow();
  });

  it("stays silent off the node runtime, which has no stdout to write to", () => {
    validEnv();
    process.env.NEXT_RUNTIME = "edge";

    register();

    expect(rawLogLines()).toHaveLength(0);
  });
});
