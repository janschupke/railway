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
 *
 * The edge runtime has no `process.stdout` at all, and this module reaches it through
 * `instrumentation.ts`, which Next compiles for both. So the branch is real rather than
 * defensive: `NEXT_RUNTIME` is a build-time constant there, the ternary folds, and the edge
 * bundle no longer contains a `node:` API it cannot call. Every request that has anywhere to
 * log to is served by the node runtime, and dropping a line nobody could have read is the
 * only honest thing the other branch can do.
 */
const sink =
  process.env.NEXT_RUNTIME === "edge"
    ? { write: () => {} }
    : { write: (chunk: string) => void process.stdout.write(chunk) };

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
 * Every event name this app emits.
 *
 * `subsystem.thing.outcome`, dotted and low-cardinality. It becomes pino's `msg`, which
 * is what a Loki label and an OTel Body both want — and a label's whole value is that
 * the set of values is small and known. errors-and-logging.md said so and nothing
 * checked it: `event: string` accepted prose, a template literal, or an id, and the
 * first person to write `log.info(\`stream \${id} closed\`)` would have turned a label
 * into a cardinality explosion with no review signal at all.
 *
 * A union rather than a lint rule, because this is a question tsc can answer exactly.
 * Adding a name here is one line and is visible in a diff, which is the review the rule
 * was asking for.
 */
export type LogEvent =
  | "action"
  | "action.session_expired"
  | "auth.callback.failed"
  | "auth.callback.token_exchange_failed"
  | "auth.login.started"
  | "boot"
  | "boot.env_invalid"
  | "auth.logout.rejected"
  /*
   * The two halves of one rule, kept as separate names because they answer different
   * questions: `auth.` is a request to a route the proxy matcher excludes, so a burst of
   * those is somebody probing the sign-in flow, while `request.` is every other path.
   * Neither ever carries the host it refused — see lib/origin.ts.
   */
  | "auth.origin_rejected"
  | "request.origin_rejected"
  | "auth.redirect.anonymous"
  | "auth.session.cleared"
  | "auth.session.created"
  | "auth.session.refresh_failed"
  | "auth.session.refresh_raced"
  | "auth.session.refreshed"
  | "auth.session.unreadable"
  | "container.create_failed"
  | "container.create_replayed"
  | "container.created"
  /*
   * `destroy_failed` has no counterpart under the other verbs on purpose. They fail by
   * ending the request, which `reportError` records under `action`; destroy is the one that
   * can be asked about several containers at once, so a refused mutation there ends one
   * entry of a batch that carries on — and this is the only line that says which.
   */
  | "container.destroy_failed"
  | "container.destroy_refused"
  | "container.destroy_skipped"
  | "container.destroyed"
  /*
   * Editing, which takes the same three shapes as the verbs below plus one of its own:
   * `edit_rejected` is the duplicate-name refusal, and it is a different event from
   * `edit_refused` on purpose — one is the ownership boundary and the other is a name
   * already in use, which are a security record and a usability record respectively.
   * `container.updated` is the `.done` line, and the only record anywhere of what a
   * container used to be: Railway keeps no history of a service's previous name or image.
   */
  | "container.edit_refused"
  | "container.edit_rejected"
  | "container.edit_skipped"
  | "container.updated"
  /*
   * The rest of the lifecycle, in the same three shapes destroy has: refused by the
   * ownership boundary, skipped because the service had already gone, or done. Every
   * `.done` line here records a change to billable infrastructure, which is the reason
   * they are `info` rather than `debug` — see actions.ts.
   */
  | "container.redeploy_refused"
  | "container.redeploy_skipped"
  | "container.redeployed"
  | "container.restart_refused"
  | "container.restart_skipped"
  | "container.restarted"
  | "container.stop_refused"
  | "container.stop_skipped"
  | "container.stopped"
  /*
   * Giving a container a public address. The same three shapes, and `domain_skipped` carries
   * a second reason the others do not: `exists`, for a stale page asking twice — Railway
   * mints a second domain rather than refusing, so that branch is the app declining rather
   * than reporting a Railway refusal.
   *
   * `container.domain_created` is `info` and part of the audit trail for the strongest
   * reason on this list: it is the record that a container was put on the public internet.
   * `railway.domain_failed` is the other half — a refusal during spin-up, which does not
   * fail the spin-up.
   */
  | "container.domain_created"
  | "container.domain_refused"
  | "container.domain_skipped"
  | "dashboard"
  | "dashboard.metrics_failed"
  | "dashboard.render"
  | "dashboard.selection_dropped"
  /*
   * The volumes read behind the container list. Debug, on every render, for the same reason
   * `dashboard.metrics_failed` is: a readout the app degrades out of by design is not an
   * incident, and a warn per render is how a log store teaches people to ignore warns.
   */
  | "dashboard.volumes_failed"
  /*
   * Neither has a `.destroyed` counterpart, and that is the design rather than a gap: this
   * app creates projects and environments and never deletes them, which is also why they
   * carry no MANAGED_PREFIX. See actions.ts.
   */
  | "environment.created"
  | "project.created"
  | "health.env_invalid"
  /*
   * The registry existence check. Both carry a `registry` and an `outcome` drawn from
   * closed sets and never the reference itself — it is an unbounded attacker-chosen string
   * arriving on a URL, and this endpoint fires on every settled keystroke, which makes it
   * the worst available candidate for a field an operator greps. Same call as the rejected
   * deploymentId on the stream route; `ref_length` carries the diagnostic content.
   */
  | "image.check_rejected"
  | "image.checked"
  | "proxy.env_invalid"
  | "railway.deploy_failed"
  /*
   * A domain Railway refused during a spin-up, and the only one of these `railway.*_failed`
   * names that does NOT stop the container being created. The container is deployed and the
   * user is told about it; what they are not given is an address, and the row's own control
   * is the retry. See createContainer.
   */
  | "railway.domain_failed"
  | "railway.deploymentPoll"
  | "railway.deployment.fallback_logs"
  | "railway.deployment.fallback_logs_failed"
  | "railway.deployment.failure_reason"
  | "railway.deployment.failure_reason_failed"
  | "railway.deployment.failure_reason_refused"
  | "railway.deployment.not_found"
  | "railway.deployment.poll_failed"
  | "railway.deployment.poll_recovered"
  | "railway.deployment.unsettled"
  | "railway.logBackfill"
  | "railway.logStream"
  | "railway.logStream.truncated"
  | "railway.metrics.refused"
  | "railway.projects"
  | "railway.projects.source_failed"
  | "railway.request"
  | "railway.request.retry"
  | "railway.variables_failed"
  /*
   * The volume a stateful preset is given, and the two ways that can go.
   *
   * `volume_created` is part of the audit trail rather than a counter: it records the name
   * Railway derived for the volume, which is what carries the ownership prefix onto it
   * (ADR-14), so a change in that behaviour shows up here rather than as a volume this app
   * quietly stops being able to identify. `volume_failed` is warn, and its consequence is
   * that the service is NOT deployed — a database that came up without its volume would
   * accept writes and lose them.
   *
   * `volumes.refused` is the read, not the write, and sits with `metrics.refused` in both
   * level and reasoning.
   */
  | "railway.volume_created"
  | "railway.volume_failed"
  | "railway.volumes.refused"
  | "render.failed"
  | "stream.closed"
  | "stream.opened"
  | "stream.rejected"
  /*
   * The edit form reading which variables a service already has. `variable_count` and never
   * a name: the moment a person can type one, the set stops being closed and stops being
   * something to hand an operator's log store. Values reach neither this record nor the
   * response — see the route handler.
   */
  | "variables.read"
  | "variables.read_rejected"
  | "watch.closed"
  | "watch.opened"
  | "watch.poll_failed"
  | "watch.rejected";

/**
 * The logging surface.
 *
 * `event` is a dotted, low-cardinality name — `auth.session.refreshed`,
 * `container.created` — not prose. It becomes pino's `msg`, which is what a Loki label
 * and an OTel Body both want, and it means a log line is greppable without a format
 * string to parse.
 */
export const log = {
  debug: <T extends LogFields<T>>(event: LogEvent, fields?: T) =>
    emit("debug", event, fields),
  info: <T extends LogFields<T>>(event: LogEvent, fields?: T) =>
    emit("info", event, fields),
  warn: <T extends LogFields<T>>(event: LogEvent, fields?: T) =>
    emit("warn", event, fields),
  error: <T extends LogFields<T>>(event: LogEvent, fields?: T) =>
    emit("error", event, fields),
};
