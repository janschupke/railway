import "server-only";

import { AsyncQueue } from "@/lib/async-queue";
import { STREAM } from "@/lib/constants";
import { log } from "@/lib/logger";
import { reportError } from "@/lib/report-error";
import { getDeployment, getLogs } from "./api";
import { RailwayApiError } from "./errors";
import { BUILD_LOGS_SUBSCRIPTION, DEPLOYMENT_LOGS_SUBSCRIPTION } from "./operations";
import { createLogClient, streamLogs } from "./subscribe";
import {
  isTerminal,
  isTransitioning,
  toContainerState,
  type ContainerState,
  type LogLine,
  type LogPhase,
} from "./types";
import type { MessageDescriptor } from "@/lib/messages";

export type MonitorEvent =
  | { type: "ready"; deploymentId: string; phase: LogPhase; backfilled: number }
  | { type: "log"; line: LogLine }
  | {
      type: "status";
      deploymentId: string;
      state: ContainerState;
      rawStatus: string | null;
      updatedAt: string | null;
    }
  // Descriptors, not sentences: the monitor has no translator and no request scope.
  | { type: "warning"; message: MessageDescriptor }
  | { type: "error"; message: MessageDescriptor }
  | { type: "done"; deploymentId: string; state: ContainerState };

/** Injection seam so the monitor is testable without a network or a socket. */
export type MonitorDeps = {
  getLogs: typeof getLogs;
  getDeployment: typeof getDeployment;
  subscribeLogs: (
    accessToken: string,
    document: string,
    field: "buildLogs" | "deploymentLogs",
    deploymentId: string,
    signal: AbortSignal,
  ) => AsyncGenerator<LogLine>;
};

const defaultDeps: MonitorDeps = {
  getLogs,
  getDeployment,
  subscribeLogs: async function* (accessToken, document, field, deploymentId, signal) {
    const client = createLogClient(accessToken);
    try {
      yield* streamLogs(client, document, field, deploymentId, signal);
    } finally {
      /*
       * Awaited, not discarded. `void` here left the socket teardown unobserved: a
       * dispose that rejects became an unhandled rejection with no context, and the
       * generator returned before the close handshake had been sent. The catch is
       * deliberate — a socket that fails to close cleanly is not worth failing the
       * stream over, but it should not crash the process either.
       *
       * Wrapped because graphql-ws types dispose() as `void | Promise<void>`; it is
       * the async branch that has a rejection to observe.
       */
      await Promise.resolve(client.dispose()).catch(() => {});
    }
  },
};

/**
 * One deployment's lifecycle as a single event stream.
 *
 * Merges two sources that Railway exposes differently:
 *  - **logs** arrive over a real graphql-ws subscription (push);
 *  - **status** has no subscription, so it is polled — but bounded to this one
 *    deployment, only while it is transitioning, ending the whole stream once it
 *    settles. That is a very different cost profile from a dashboard-wide poll.
 *
 * On a terminal status the stream waits DRAIN_MS before finishing so trailing log
 * frames still land; a build's last lines routinely arrive after the status flips.
 */
export async function* monitorDeployment(
  params: {
    accessToken: string;
    deploymentId: string;
    phase: LogPhase;
    signal: AbortSignal;
  },
  deps: MonitorDeps = defaultDeps,
): AsyncGenerator<MonitorEvent> {
  const { accessToken, deploymentId, phase, signal } = params;
  const queue = new AsyncQueue<MonitorEvent>(STREAM.MAX_QUEUED_EVENTS);

  // One holder so `stop` can clear timers that are created further down.
  const timers: {
    status?: ReturnType<typeof setInterval>;
    drain?: ReturnType<typeof setTimeout>;
  } = {};

  const stop = () => {
    if (timers.status) clearInterval(timers.status);
    if (timers.drain) clearTimeout(timers.drain);
    queue.end();
  };
  signal.addEventListener("abort", stop, { once: true });

  /*
   * Every line this stream has put on the wire, backfill included.
   *
   * The fallback below turns on exactly one condition — a deployment that failed having
   * shown the reader nothing at all — and there is no other way to know that from here.
   */
  let linesEmitted = 0;

  // Backfill first so attaching mid-build does not start from an empty pane.
  try {
    const backfill = await deps.getLogs(
      accessToken,
      deploymentId,
      phase,
      STREAM.BACKFILL_LINES,
      signal,
    );
    for (const line of backfill) queue.push({ type: "log", line });
    linesEmitted += backfill.length;
    queue.push({ type: "ready", deploymentId, phase, backfilled: backfill.length });
  } catch (error) {
    // Missing history is not fatal — the live subscription may still work.
    queue.push({
      type: "warning",
      message: reportError("railway.logBackfill", error, "errors.logBackfillFailed"),
    });
    queue.push({ type: "ready", deploymentId, phase, backfilled: 0 });
  }

  let missingPolls = 0;
  let unsettledPolls = 0;
  let consecutiveFailures = 0;
  /*
   * Set synchronously the moment a terminal status is first seen.
   *
   * `timers.drain` was a sufficient guard while the terminal branch ran start to finish in
   * one tick. It no longer does: the fallback below awaits, and the status interval does
   * not wait for the previous call to return, so two polls could both pass a check on a
   * timer that neither had assigned yet and fetch — and emit — the same fallback twice.
   */
  let settling = false;

  /**
   * Last resort for a failure that showed the reader nothing.
   *
   * A row picks its log phase from a status that is as old as the page, and `phaseFor`
   * sends a failed deployment to deploy logs — so a build-phase failure on a container
   * that was already failed when the page loaded (a reload, or one that failed while
   * nobody was looking) asks Railway for the one half of the output that is empty, and
   * the pane reports "No log output for this deployment." That is also the shape of the
   * case this exists for: an image source performs no build, so a pull that fails writes
   * to whichever phase Railway decides, and the app cannot know which in advance.
   *
   * Deliberately failed-only, and empty-only. A successful deployment with no output is a
   * normal, common state — a seeded database service is one — and fetching the other phase
   * for every quiet success would double the query cost of the commonest case to answer a
   * question nobody asked.
   *
   * Best effort throughout: this runs while the user is already looking at a failure, and
   * a failure to explain the failure is not worth a second banner over the first.
   */
  const explainFailure = async () => {
    if (linesEmitted > 0) return;
    const other: LogPhase = phase === "build" ? "deploy" : "build";
    try {
      const lines = await deps.getLogs(
        accessToken,
        deploymentId,
        other,
        STREAM.BACKFILL_LINES,
        signal,
      );
      for (const line of lines) queue.push({ type: "log", line });
      linesEmitted += lines.length;
      log.debug("railway.deployment.fallback_logs", {
        deployment_id: deploymentId,
        from_phase: other,
        lines: lines.length,
      });
    } catch (error) {
      if (signal.aborted) return;
      log.debug("railway.deployment.fallback_logs_failed", {
        deployment_id: deploymentId,
        from_phase: other,
        error,
      });
    }
  };

  const pollStatus = async () => {
    try {
      const deployment = await deps.getDeployment(accessToken, deploymentId, signal);
      if (!deployment) {
        /*
         * A null on the first poll or two is normal — Railway is eventually consistent
         * and this fires milliseconds after the deploy mutation returns. A sustained
         * null is not: it used to `return` silently, so an identifier that never
         * resolved kept this interval and an upstream socket alive for the full
         * duration ceiling. Requests are cheap to make and were expensive to ignore.
         */
        if (++missingPolls < STREAM.MISSING_POLLS_BEFORE_STOP) return;
        log.warn("railway.deployment.not_found", {
          deployment_id: deploymentId,
          polls: missingPolls,
        });
        queue.push({ type: "error", message: { key: "errors.deploymentNotFound" } });
        stop();
        return;
      }
      missingPolls = 0;

      if (consecutiveFailures > 0) {
        log.warn("railway.deployment.poll_recovered", {
          deployment_id: deploymentId,
          after: consecutiveFailures,
        });
        consecutiveFailures = 0;
      }

      const state = toContainerState(deployment.status);
      queue.push({
        type: "status",
        deploymentId,
        state,
        rawStatus: deployment.status,
        updatedAt: deployment.updatedAt,
      });

      if (isTerminal(state) && !settling) {
        settling = true;
        if (timers.status) clearInterval(timers.status);

        /*
         * Before the drain window is armed, not inside it. `stop()` ends the queue and
         * AsyncQueue drops everything pushed after that, so a fallback resolving a moment
         * late would be discarded in silence — the same empty pane, with more code behind
         * it. The drain still does its own job afterwards: trailing frames from the live
         * subscription routinely arrive after the status flips.
         */
        if (state === "failed") await explainFailure();
        if (signal.aborted) return;

        timers.drain = setTimeout(() => {
          queue.push({ type: "done", deploymentId, state });
          stop();
        }, STREAM.DRAIN_MS);
        return;
      }

      /*
       * Neither settled nor moving. Only `unknown` reaches here, and it means Railway
       * reported a status this app does not map — so there is no transition to wait for
       * and no terminal state to declare. Left unbounded it polled for the full ceiling
       * and then closed with no frame at all, which the browser answers by redialling.
       */
      if (!isTransitioning(state)) {
        if (++unsettledPolls >= STREAM.UNSETTLED_POLLS_BEFORE_STOP) {
          log.warn("railway.deployment.unsettled", {
            deployment_id: deploymentId,
            state,
            raw_status: deployment.status,
            polls: unsettledPolls,
          });
          queue.push({ type: "done", deploymentId, state });
          stop();
        }
        return;
      }
      unsettledPolls = 0;
    } catch (error) {
      if (error instanceof RailwayApiError && error.kind === "auth") {
        /*
         * Fatal, and deliberately not retried — the same reasoning the watch route states
         * at its own auth branch. This cannot be an expiry: the route clamps the stream's
         * lifetime to what is left of the access token (streamDurationMs), so a token
         * running out closes the connection and the browser's redial re-authenticates.
         * What reaches here is a grant that was revoked or never covered this deployment,
         * and polling either of those for the rest of the ceiling burns quota to arrive at
         * the same refusal. describe() picks which of the three it was; the stream ends
         * saying so rather than going quiet.
         */
        queue.push({
          type: "error",
          message: reportError("railway.deploymentPoll", error, "errors.generic"),
        });
        stop();
        return;
      }

      /*
       * A poll in flight when the browser hangs up aborts, and that is teardown rather
       * than failure — the log subscription below already guards on the same condition.
       * Without this, closing a tab produced an AbortError at `warn` on every stream
       * that happened to be mid-poll, which is precisely the false positive that teaches
       * people to ignore warnings.
       */
      if (signal.aborted) return;

      /*
       * Transient failures: the next tick retries — and until now that comment was the
       * only evidence they had happened at all. A deployment could poll-fail for the
       * full fifteen-minute ceiling in silence.
       *
       * Logged on the transition rather than per tick, because a naive line here is 360
       * records per wedged stream (2.5s × 15 min) and Railway charges for retained
       * stdout. First failure and recovery are `warn`; the steady state is `debug`, so a
       * fifteen-minute outage costs two lines and the detail is still there on request.
       */
      consecutiveFailures += 1;
      const fields = {
        deployment_id: deploymentId,
        consecutive: consecutiveFailures,
        error,
      };
      if (consecutiveFailures === 1) log.warn("railway.deployment.poll_failed", fields);
      else log.debug("railway.deployment.poll_failed", fields);
    }
  };

  timers.status = setInterval(() => void pollStatus(), STREAM.STATUS_POLL_MS);
  void pollStatus();

  const document =
    phase === "build" ? BUILD_LOGS_SUBSCRIPTION : DEPLOYMENT_LOGS_SUBSCRIPTION;
  const field = phase === "build" ? "buildLogs" : "deploymentLogs";

  /*
   * Said once, on the transition to dropping, rather than per dropped line — the whole
   * point is that the consumer is already behind, so a warning per drop would be the
   * loudest possible way to make that worse.
   */
  let truncationReported = false;

  const logs = (async () => {
    try {
      for await (const line of deps.subscribeLogs(
        accessToken,
        document,
        field,
        deploymentId,
        signal,
      )) {
        queue.push({ type: "log", line });
        linesEmitted += 1;
        if (queue.dropped > 0 && !truncationReported) {
          truncationReported = true;
          log.warn("railway.logStream.truncated", {
            deployment_id: deploymentId,
            max_queued: STREAM.MAX_QUEUED_EVENTS,
          });
          queue.push({ type: "warning", message: { key: "errors.logsTruncated" } });
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        /*
         * This detail is not Railway's prose — it is whatever `ws` threw, which means
         * `connect ECONNREFUSED <resolved-ip>:<port>` or `getaddrinfo ENOTFOUND <host>`.
         * That was going straight into a Banner.
         */
        queue.push({
          type: "warning",
          message: reportError("railway.logStream", error, "errors.streamInterrupted"),
        });
      }
    }
  })();

  try {
    yield* queue;
  } finally {
    stop();
    signal.removeEventListener("abort", stop);
    /*
     * Attach a rejection handler, and deliberately do NOT await.
     *
     * `void logs;` was a no-op wearing a comment: it evaluates an already-running
     * promise and discards it, so a rejection had nowhere to go and would surface as an
     * unhandled rejection with no context attached. `.catch()` fixes that much.
     *
     * Awaiting it was tried and reverted. The subscription only returns once it observes
     * `signal`, so awaiting makes this generator's completion depend on an upstream
     * behaving — which is the precise failure the SSE transport keeps onClose out of a
     * producer `finally` to avoid, and which deadlocked a test whose fake ignores the
     * signal. Teardown must not be able to hang on the thing it is tearing down.
     */
    void logs.catch(() => {});
  }
}
