import { describe, expect, it, vi } from "vitest";
import { logRecords, rawLogLines } from "@/test/log-capture";
import { RailwayApiError } from "@/lib/railway/errors";
import { runWithRequestContext, setSubjectId } from "@/lib/log/context";
import { log } from "./logger";

const only = () => {
  const records = logRecords();
  expect(records).toHaveLength(1);
  return records[0]!;
};

describe("log", () => {
  it("emits one JSON line per call, with the event as the message", () => {
    log.info("container.created", { image: "nginx:1.27", service_id: "svc_1" });

    expect(only()).toMatchObject({
      level: "info",
      msg: "container.created",
      image: "nginx:1.27",
      service_id: "svc_1",
    });
  });

  it("stamps the resource fields an OTel collector maps onto service.*", () => {
    log.info("railway.request");
    const record = only();

    expect(record.service).toBe("container-console");
    expect(record.env).toBeTypeOf("string");
    expect(record.version).toBeTypeOf("string");
  });

  it("emits a string level and an epoch-ms time, both left at pino's defaults", () => {
    // Grafana reads `level` as a label and `time` with a UnixMs stage; the OTel bridge
    // reads `msg` as the body. Not overriding these is the readiness work.
    log.warn("railway.request");
    const record = only();

    expect(record.level).toBe("warn");
    expect(record.time).toBeTypeOf("number");
    expect(record.time).toBeGreaterThan(1_700_000_000_000);
  });

  it("drops pid and hostname, which Railway already stamps", () => {
    log.info("railway.request");
    expect(Object.keys(only())).not.toContain("pid");
    expect(Object.keys(only())).not.toContain("hostname");
  });

  describe("request context", () => {
    it("adds the request id to every record inside a scope", () => {
      runWithRequestContext({ requestId: "abc", route: "/dashboard" }, () => {
        log.info("dashboard.render");
      });

      expect(only()).toMatchObject({ request_id: "abc", route: "/dashboard" });
    });

    it("picks up a subject learned after the scope was entered", () => {
      // The mixin runs per call, which is why this works and a child logger would not.
      runWithRequestContext({ requestId: "abc" }, () => {
        setSubjectId("user_9");
        log.info("auth.session.created");
      });

      expect(only().subject_id).toBe("user_9");
    });

    it("omits the fields entirely outside a scope", () => {
      log.info("railway.request");
      expect(Object.keys(only())).not.toContain("request_id");
    });
  });

  describe("errors", () => {
    it("serializes a failure into queryable fields under err", () => {
      const error = new RailwayApiError("Not Authorized", {
        kind: "auth",
        operation: "Projects",
        path: ["me", "workspaces"],
      });

      log.error("railway.projects", { incident: error.incidentId, error });

      expect(only()).toMatchObject({
        msg: "railway.projects",
        incident: error.incidentId,
        err: {
          type: "RailwayApiError",
          kind: "auth",
          operation: "Projects",
          path: "me.workspaces",
          missing_scope: "workspace:viewer",
        },
      });
    });

    /*
     * The canary at the facade layer. serialize-error.test.ts proves the serializer drops
     * `cause`; this proves the wiring actually routes through it — a change to pino's
     * options or to `emit()` that bypassed the serializer would pass there and fail here.
     */
    it("never writes a credential carried on cause", () => {
      log.error("auth.callback.token_exchange_failed", {
        error: new Error("unsupported token_type value", {
          cause: { body: { access_token: "AT-CANARY", refresh_token: "RT-CANARY" } },
        }),
      });

      const written = rawLogLines().join("");

      expect(written).not.toContain("AT-CANARY");
      expect(written).not.toContain("RT-CANARY");
      expect(written).not.toContain("cause");
      // …and still says what failed, so deleting the log line does not satisfy the test.
      expect(written).toContain("unsupported token_type value");
    });

    it("redacts a credential passed under a known key name", () => {
      // The backstop, not the control — it catches one level. Worth proving it is armed.
      log.info("railway.request", { access_token: "AT-CANARY" });

      expect(rawLogLines().join("")).not.toContain("AT-CANARY");
    });
  });

  it("refuses a non-scalar field at compile time", () => {
    /*
     * The primary defence, asserted rather than assumed. pino's serializers are keyed by
     * field *name*, so `{ error }` under any other key would be JSON-stringified whole —
     * and `cause` is an enumerable own property on both error classes here. The leak is
     * one character wide, so the type has to be the thing that closes it, and a type
     * that silently permits an object is worse than none.
     */
    // @ts-expect-error — fails the build if this ever starts type-checking.
    log.info("railway.request", { session: { accessToken: "AT-CANARY" } });

    /*
     * And when the type is bypassed — as it is here — the second layer catches this
     * particular shape. Worth asserting for what it does *not* prove: `redact` matches
     * one level, so a credential one key deeper would survive. The type is the control;
     * this is the net under it.
     */
    expect(rawLogLines().join("")).toContain("[redacted]");
    expect(rawLogLines().join("")).not.toContain("AT-CANARY");
  });

  it("honours the level threshold", () => {
    // LOG_LEVEL is "debug" in tests, so trace must be the one that is dropped.
    log.debug("railway.request");
    expect(logRecords()).toHaveLength(1);
  });

  it("writes nothing on the edge runtime, which has no stdout at all", async () => {
    /*
     * Next compiles `instrumentation.ts` for both runtimes, so this module reaches the edge
     * one whether or not anything there ever calls it — and a static `process.stdout` in an
     * edge bundle is a build warning on every run, correctly. `NEXT_RUNTIME` is a build-time
     * constant there, so the branch folds and the API is gone from the bundle rather than
     * merely unreached.
     *
     * Re-imported rather than asserted through the live instance, because the destination is
     * chosen once when the module loads — which is the whole point of it folding.
     */
    const restore = process.env.NEXT_RUNTIME;
    process.env.NEXT_RUNTIME = "edge";
    vi.resetModules();
    try {
      const edge = await import("./logger");
      edge.log.error("railway.request", { issues: "EDGE-CANARY" });
      expect(rawLogLines().join("")).not.toContain("EDGE-CANARY");
    } finally {
      process.env.NEXT_RUNTIME = restore;
      vi.resetModules();
    }
  });
});
