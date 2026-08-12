import pino from "pino";
import { errorFields } from "@/lib/log/serialize-error";
import { requestContext } from "@/lib/log/context";

/**
 * Structured logs on stdout, shaped so an OTel collector can read them unchanged.
 *
 * Railway captures stdout and nothing else, so stdout is the sink and a shipper is a
 * later decision no code change should be waiting on. What this step buys is the part
 * that *is* expensive to retrofit: stable event names, a request id that survives the
 * proxy → render → stream handoff, and an error serializer that cannot leak a credential.
 *
 * No `import "server-only"`. src/proxy.ts imports this, and there `server-only`'s exports
 * map resolves to a bare `throw` — the same reason the auth modules omit it, documented
 * in eslint.config.mjs.
 */

const LEVELS = new Set(["silent", "error", "warn", "info", "debug", "trace"]);

/*
 * LOG_LEVEL is read straight from the environment rather than through src/env.ts, which
 * is the one deliberate exception to "all configuration is validated in env.ts":
 *
 * - api/health/route.ts exists in order to log `env()` failing. A logger that called
 *   `env()` could not report that failure — it would throw inside the catch block.
 * - proxy.ts calls `env()` on every request. A logger that also threw at module
 *   evaluation would turn a misconfigured deployment into a boot loop with no output.
 * - `env()` is a memo with a `__resetEnv()` for tests. That is the wrong lifetime for a
 *   process-lifetime singleton.
 *
 * An unrecognised value therefore clamps silently. A logger must never be the component
 * that refuses to start.
 */
const configured = process.env.LOG_LEVEL;
const level =
  configured && LEVELS.has(configured)
    ? configured
    : process.env.NODE_ENV === "production"
      ? "info"
      : "debug";

/**
 * The single byte-level exit.
 *
 * pino's default destination is `pino.destination(1)` — a SonicBoom writing to fd 1 with
 * `fs.write`, which bypasses `process.stdout` entirely and is therefore invisible to the
 * test suite. Routing through `process.stdout` is what makes the credential canaries
 * assertable over the real code path. It costs nothing here: on Railway stdout is a pipe,
 * and pipe writes are already buffered and non-blocking (only TTYs and regular files are
 * synchronous on POSIX), and nothing in this design logs per request or per log line.
 */
const sink = { write: (chunk: string) => void process.stdout.write(chunk) };

/**
 * A backstop, not the control.
 *
 * `@pinojs/redact`'s `*` matches one level, so this cannot catch a credential nested at
 * arbitrary depth — it exists to turn a mistake into a visible `[redacted]`. The controls
 * are the scalar-only `LogFields` type below, `errorFields`' allow-list, and
 * `describeOidcFailure` keeping raw OIDC errors away from here entirely.
 */
const SECRET_KEYS = [
  "cause",
  "access_token",
  "refresh_token",
  "id_token",
  "accessToken",
  "refreshToken",
  "authorization",
  "cookie",
  "client_secret",
  "code_verifier",
  "password",
];

// Both spellings: a bare path matches the top level, `*.x` matches one level down. A
// single form would have left half the shape uncovered, which a test now proves.
const REDACT_PATHS = SECRET_KEYS.flatMap((key) => [key, `*.${key}`]);

const logger = pino(
  {
    level,
    /*
     * Replaces pino's default pid+hostname: pid is 1 in a container and hostname is the
     * replica id, which Railway already stamps on every line. These three are the fields
     * an OTel Resource will carry as service.name / deployment.environment.name /
     * service.version, spelled once so the collector config is a rename, not a rewrite.
     */
    base: {
      service: "container-console",
      env:
        process.env.RAILWAY_ENVIRONMENT_NAME ?? process.env.NODE_ENV ?? "development",
      version: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? "dev",
    },
    // pino's default epoch-ms `time`. Left alone on purpose: the OTel bridge and Grafana
    // Alloy's `UnixMs` timestamp stage both read it as-is.
    timestamp: pino.stdTimeFunctions.epochTime,
    /*
     * String labels rather than pino's numeric levels. Railway's own log viewer is the
     * actual reader today and it colours on a string. The OTel bridge's severity mapping
     * may prefer the number — that is one line in this file to revisit, and the field
     * name does not change either way.
     */
    formatters: { level: (label) => ({ level: label }) },
    serializers: { err: errorFields },
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    /*
     * A mixin rather than a child logger: it runs per call, so a subject id learned after
     * the scope was entered still lands on lines logged later, and an explicit field
     * still wins over it.
     */
    mixin() {
      const context = requestContext();
      if (!context) return {};
      return {
        request_id: context.requestId,
        ...(context.subjectId ? { subject_id: context.subjectId } : {}),
        ...(context.route ? { route: context.route } : {}),
      };
    },
  },
  sink,
);

/**
 * Scalars only.
 *
 * This type is the primary defence against a credential reaching a log line, and it is
 * load-bearing rather than tidy: pino's serializers are keyed by field *name*, so
 * `logger.error({ error }, msg)` — `error`, not `err` — gets no serializer at all, and
 * `cause` is an enumerable own property on both error classes in this app. The leak is
 * one character wide. Making an object unassignable closes it at compile time; the
 * serializer and the redact paths are then genuine backstops rather than the only line.
 */
type Scalar = string | number | boolean | null | undefined;

/**
 * Every field must be a scalar — except `error`, which is the one sanctioned way to put
 * a non-scalar into a record and is not an exception to the rule so much as the reason
 * for it: anything under `error` goes through `errorFields` and comes out as an
 * allow-listed subset. Available at every level, because an expired session is worth an
 * `info` line that still names which failure it was.
 *
 * Written as a mapped type over the caller's own object rather than
 * `Record<string, Scalar> & { error?: unknown }`, which does not work: the index
 * signature constrains `error` too, and the intersection is unsatisfiable. Used as a
 * self-referential constraint (`T extends LogFields<T>`), so an object literal is
 * checked key by key at the call site.
 */
export type LogFields<T> = { [K in keyof T]: K extends "error" ? unknown : Scalar };

function emit(
  method: "debug" | "info" | "warn" | "error",
  event: string,
  fields?: Record<string, unknown>,
): void {
  if (!fields) {
    logger[method](event);
    return;
  }
  const { error, ...rest } = fields;
  /*
   * The raw error goes under `err` and pino's serializer converts it — not this function.
   * Serializing here as well would apply `errorFields` twice, and the second pass sees a
   * plain object rather than an Error and collapses it to "[non-error object]". One
   * mechanism, at the place a pino reader expects to find it.
   */
  logger[method](error === undefined ? rest : { ...rest, err: error }, event);
}

/**
 * The logging surface.
 *
 * `event` is a dotted, low-cardinality name — `auth.session.refreshed`,
 * `container.created` — not prose. It becomes pino's `msg`, which is what a Loki label
 * and an OTel Body both want, and it means a log line is greppable without a format
 * string to parse.
 */
export const log = {
  debug: <T extends LogFields<T>>(event: string, fields?: T) =>
    emit("debug", event, fields),
  info: <T extends LogFields<T>>(event: string, fields?: T) =>
    emit("info", event, fields),
  warn: <T extends LogFields<T>>(event: string, fields?: T) =>
    emit("warn", event, fields),
  error: <T extends LogFields<T>>(event: string, fields?: T) =>
    emit("error", event, fields),
};
