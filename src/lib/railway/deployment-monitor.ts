import "server-only";

import { AsyncQueue } from "@/lib/async-queue";
import { STREAM } from "@/lib/constants";
import { log } from "@/lib/logger";
import { expectReplay } from "@/lib/log-overlap";
import { reportError } from "@/lib/report-error";
import { sleep } from "@/lib/utils";
import { getDeployment, getDeploymentFailure, getLogs } from "./deployment-reads";
import { RailwayApiError } from "./errors";
import { backoffFor, healthyInterval } from "./poll-cadence";
import { BUILD_LOGS_SUBSCRIPTION, DEPLOYMENT_LOGS_SUBSCRIPTION } from "./operations";
import {
  createLogClient,
  streamLogs,
  type LogSubscriptionDocument,
  type LogSubscriptionField,
} from "./subscribe";
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
  /**
   * What Railway said about a terminal failure, when it said anything.
   *
   * The one variant carrying upstream free text rather than a catalog key, because
   * nothing on this side chooses the words — see getDeploymentFailure, and the accepted
   * risk in SECURITY.md for why this text is a different class from a GraphQL error.
   *
   * The field is `reason` and NOT `message`, and that is load-bearing: the SSE route
   * branches on `"message" in event` and would hand this string to `t()` as if it were a
   * catalog key. A future variant carrying free text must avoid that name too.
   */
  | {
      type: "failure";
      deploymentId: string;
      step: string | null;
      reason: string | null;
    }
  // Descriptors, not sentences: the monitor has no translator and no request scope.
  | { type: "warning"; message: MessageDescriptor }
  | { type: "error"; message: MessageDescriptor }
  | { type: "done"; deploymentId: string; state: ContainerState };

/** Injection seam so the monitor is testable without a network or a socket. */
export type MonitorDeps = {
  getLogs: typeof getLogs;
  getDeployment: typeof getDeployment;
  getDeploymentFailure: typeof getDeploymentFailure;
  subscribeLogs: (
    accessToken: string,
    document: LogSubscriptionDocument,
    field: LogSubscriptionField,
    deploymentId: string,
    signal: AbortSignal,
  ) => AsyncGenerator<LogLine>;
};

const defaultDeps: MonitorDeps = {
  getLogs,
  getDeployment,
  getDeploymentFailure,
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

  /*
   * The poll loop's own stop signal, composed with the caller's.
   *
   * Polling ends for two different reasons and only one of them is the reader's: a terminal
   * status, a status this app cannot map, and an id that never resolves all mean this
   * stream has finished asking Railway while the connection — and, for a terminal status,
   * the drain window — is still very much open. Aborting this controller is what clearing
   * the status interval used to do.
   *
   * Composed rather than checked alongside `signal`, because AbortSignal.any is already
   * aborted when a member is: a caller that hands in a dead signal never fires `abort`, so
   * the listener below never runs and the loop would poll for a reader that had gone.
   */
  const polling = new AbortController();
  const pollSignal = AbortSignal.any([signal, polling.signal]);

  // Armed once, on a terminal status. No holder object any more: the status timer it used
  // to share this scope with is a loop.
  let drainTimer: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    polling.abort();
    if (drainTimer) clearTimeout(drainTimer);
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

  /**
   * The one place a log line goes on the wire, so the counter cannot drift from it.
   *
   * It did not before, but it was three sites away from doing so: the replay guard below
   * suppresses lines, and a suppressed line must not count as something the reader was
   * shown — that is the entire question `linesEmitted` exists to answer.
   */
  const emit = (line: LogLine) => {
    queue.push({ type: "log", line });
    linesEmitted += 1;
  };

  /*
   * Hoisted out of the try so a backfill that FAILED leaves this empty rather than
   * unassigned. An empty guard suppresses nothing, which is the right posture: with no
   * history on screen, every line the subscription replays is a line the reader has not
   * seen.
   */
  let backfill: LogLine[] = [];

  // Backfill first so attaching mid-build does not start from an empty pane.
  try {
    backfill = await deps.getLogs(
      accessToken,
      deploymentId,
      phase,
      STREAM.BACKFILL_LINES,
      signal,
    );
    for (const line of backfill) emit(line);
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
   * The gap before the next poll, and the two things that move it.
   *
   * A flat 2.5s was 360 requests per fifteen-minute stream and 1,440 an hour for the four
   * streams MAX_CONCURRENT_PER_USER allows, against a Hobby quota of 1,000 — the status
   * poll alone could exhaust the plan this app is meant to run on, before the project
   * watcher or a dashboard render had asked for anything.
   *
   * `sameStatePolls` counts polls that reported what the one before them did, and the reset
   * below — at every transition — is the half of the cadence that belongs here rather than in
   * `poll-cadence.ts`: how far to back off is arithmetic, but what counts as progress is a
   * statement about this deployment.
   */
  let lastState: ContainerState | undefined;
  let sameStatePolls = 0;
  let interval: number = STREAM.STATUS_POLL_MS;

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
      for (const line of lines) emit(line);
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

  /**
   * What Railway says went wrong, asked once when the deployment has already failed.
   *
   * Deliberately NOT gated on `linesEmitted`, unlike the fallback above. That gate answers
   * "did the reader see anything at all", which is a question `linesEmitted` can answer.
   * This one answers "why did it fail", and log output is not an answer to it: the
   * commonest real shape is a build that printed two hundred plausible lines and then
   * failed on HEALTHCHECK, where the pane is full and the row still says nothing but
   * "Failed". Gating here would hide the feature in exactly the case it exists for.
   *
   * The cost argument does not carry over either. The fallback's gate protects the
   * *commonest* case — a quiet success, on every settle. This runs on `failed` only, and
   * the terminal branch is reached once because the poll loop is serial: one request per
   * failed deployment, against a poll that spends one every STREAM.STATUS_POLL_MS, at the
   * moment the user is looking at a red badge asking this exact question.
   *
   * Best effort throughout, for the reason the fallback gives: a failure to explain the
   * failure is not worth a banner over the one the user is already reading.
   */
  const describeFailure = async () => {
    try {
      const failure = await deps.getDeploymentFailure(
        accessToken,
        deploymentId,
        signal,
      );
      if (!failure) return;
      queue.push({
        type: "failure",
        deploymentId,
        step: failure.step,
        reason: failure.reason,
      });
    } catch (error) {
      if (signal.aborted) return;
      log.debug("railway.deployment.failure_reason_failed", {
        deployment_id: deploymentId,
        error,
      });
    }
  };

  const pollStatus = async () => {
    try {
      const deployment = await deps.getDeployment(
        accessToken,
        deploymentId,
        pollSignal,
      );
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

      /*
       * Progress resets the cadence; standing still stretches it. Before the branches
       * below rather than after, so a poll that returns early still leaves the right delay
       * behind it — and after the push, so what the reader was told is what "changed" is
       * measured against.
       */
      if (state === lastState) sameStatePolls += 1;
      else {
        lastState = state;
        sameStatePolls = 0;
      }
      interval = healthyInterval(sameStatePolls);

      if (isTerminal(state)) {
        /*
         * Stops the poll loop without ending the queue — `stop()` would discard the drain
         * window, which is the whole reason this branch is not simply `stop()`. It is also
         * what retired the `settling` flag: polls are serial now, so nothing can be in
         * flight to reach this branch a second time while the fallback below is awaited.
         */
        polling.abort();

        /*
         * Before the drain window is armed, not inside it. `stop()` ends the queue and
         * AsyncQueue drops everything pushed after that, so a fallback resolving a moment
         * late would be discarded in silence — the same empty pane, with more code behind
         * it. The drain still does its own job afterwards: trailing frames from the live
         * subscription routinely arrive after the status flips.
         */
        /*
         * Sequential rather than Promise.all. Concurrency would halve the worst-case
         * latency added here and would make frame order nondeterministic in the fake-timer
         * tests to buy it — for no user-visible gain, since the badge has already flipped
         * to Failed by the time either request goes out.
         */
        if (state === "failed") {
          await explainFailure();
          await describeFailure();
        }
        // The caller's signal, deliberately: `pollSignal` was aborted three lines up.
        if (signal.aborted) return;

        drainTimer = setTimeout(() => {
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
       *
       * `pollSignal`, not `signal`: this stream now cancels its own request when it stops
       * polling, and a stop it decided on itself is not news about Railway either.
       */
      if (pollSignal.aborted) return;

      /*
       * Transient failures: the loop retries, after doubling the gap. It used to retry at
       * the flat base interval straight through a 429 storm, and each of those attempts
       * was itself worth up to NETWORK.MAX_ATTEMPTS requests inside the client.
       *
       * Logged on the transition rather than per attempt, because a naive line here is one
       * record per poll and Railway charges for retained stdout. First failure and recovery
       * are `warn`; the steady state is `debug`, so a fifteen-minute outage costs two lines
       * and the detail is still there on request. `backoff_ms` rides along for the reason
       * the client puts it on railway.request.retry: a backoff nobody can observe is
       * indistinguishable from one that is not happening.
       */
      consecutiveFailures += 1;
      interval = backoffFor(error, interval);
      const fields = {
        deployment_id: deploymentId,
        consecutive: consecutiveFailures,
        backoff_ms: interval,
        error,
      };
      if (consecutiveFailures === 1) log.warn("railway.deployment.poll_failed", fields);
      else log.debug("railway.deployment.poll_failed", fields);
    }
  };

  /*
   * One poll at a time, with the next gap chosen after the previous one has come back.
   *
   * `setInterval` fired on wall-clock time whether or not the poll it had started last time
   * had returned, so a slow or failing Railway received *more* concurrent requests exactly
   * when it wanted fewer, and missingPolls, unsettledPolls and consecutiveFailures were
   * counters two overlapping calls could both read and write. It also needed a flag to stop
   * two polls from both seeing a terminal status and both fetching the failure fallback;
   * running them in series retires the flag rather than guarding it.
   *
   * `while` over a re-armed setTimeout because `sleep` already observes a signal and clears
   * its own timer — a timeout handle would have to be held and cleared by `stop()`, which
   * is the bookkeeping this replaces. It is also the shape the project watcher's poll loop
   * already uses.
   *
   * Nothing awaits this promise; see the note at the end of this generator.
   */
  const polls = (async () => {
    while (!pollSignal.aborted) {
      await pollStatus();
      await sleep(interval, pollSignal);
    }
  })();

  const document =
    phase === "build" ? BUILD_LOGS_SUBSCRIPTION : DEPLOYMENT_LOGS_SUBSCRIPTION;
  const field = phase === "build" ? "buildLogs" : "deploymentLogs";

  /*
   * Said once, on the transition to dropping, rather than per dropped line — the whole
   * point is that the consumer is already behind, so a warning per drop would be the
   * loudest possible way to make that worse.
   */
  let truncationReported = false;

  /*
   * Railway answers `subscribe` with the most recent 100 lines before any live output —
   * the subscription's documented default `limit`, and it takes no `startDate` to bound it
   * with. The backfill above has just shown the reader those same lines, so without this
   * every attach printed its history twice.
   *
   * Armed from the backfill for THIS phase only. `explainFailure` reads the other one, and
   * it runs on a terminal poll rather than before the socket, so its lines can never be
   * what this subscription is repeating.
   */
  const replayed = expectReplay(backfill, STREAM.REPLAY_SCAN_LINES);

  const logs = (async () => {
    try {
      for await (const line of deps.subscribeLogs(
        accessToken,
        document,
        field,
        deploymentId,
        signal,
      )) {
        if (replayed(line)) continue;
        emit(line);
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
     *
     * The poll loop looks safer than the subscription, because `stop()` above aborts the
     * signal it sleeps on. It is not: the request it may be sitting in is a `deps`
     * function, and a fake — or a fetch that never observes its signal — does not return
     * because this side asked. The same rule applies to whichever of the two it is.
     */
    void polls.catch(() => {});
    void logs.catch(() => {});
  }
}
