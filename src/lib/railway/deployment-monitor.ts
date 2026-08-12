import "server-only";

import { AsyncQueue } from "@/lib/async-queue";
import { STREAM } from "@/lib/constants";
import { getDeployment, getLogs } from "./api";
import { RailwayApiError } from "./errors";
import { BUILD_LOGS_SUBSCRIPTION, DEPLOYMENT_LOGS_SUBSCRIPTION } from "./operations";
import { createLogClient, streamLogs } from "./subscribe";
import {
  isTerminal,
  toContainerState,
  type ContainerState,
  type LogLine,
} from "./types";
import type { MessageDescriptor } from "@/lib/messages";

export type LogPhase = "build" | "deploy";

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
      message:
        error instanceof RailwayApiError
          ? error.describe()
          : { key: "errors.logBackfillFailed" },
    });
    queue.push({ type: "ready", deploymentId, phase, backfilled: 0 });
  }

  const pollStatus = async () => {
    try {
      const deployment = await deps.getDeployment(accessToken, deploymentId, signal);
      if (!deployment) return;

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
      }
    } catch (error) {
      if (error instanceof RailwayApiError && error.kind === "auth") {
        queue.push({ type: "error", message: error.describe() });
        stop();
      }
      // Transient failures: the next tick retries.
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
        queue.push({
          type: "warning",
          message:
            error instanceof Error
              ? {
                  key: "errors.streamInterruptedDetail",
                  values: { detail: error.message },
                }
              : { key: "errors.streamInterrupted" },
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
