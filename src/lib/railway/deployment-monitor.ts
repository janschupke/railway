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
      void client.dispose();
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
  const queue = new AsyncQueue<MonitorEvent>();

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

      if (isTerminal(state) && !timers.drain) {
        if (timers.status) clearInterval(timers.status);
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
    // Let the subscription unwind; it is already aborted by this point.
    void logs;
  }
}
