import { type NextRequest } from "next/server";
import { getTranslations } from "next-intl/server";
import { requireSessionOrUnauthorized } from "@/lib/auth/route-guard";
import { getProjectContainers } from "@/lib/railway/projects";
import { RailwayApiError } from "@/lib/railway/errors";
import { fingerprint } from "@/lib/railway/watch-fingerprint";
import { sseResponse } from "@/lib/sse";
import { log } from "@/lib/logger";
import { withRequestScope } from "@/lib/log/request-scope";
import { streamCloser, streamDurationMs } from "@/lib/stream-route";
import { sleep } from "@/lib/utils";
import { acquireStreamSlot } from "@/lib/stream-slots";
import { WATCH } from "@/lib/constants";
import { env } from "@/env";
import { RAILWAY_ID_PATTERN } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Tells a tab that its project changed. Nothing more than that.
 *
 * Railway publishes log subscriptions and no project, service or deployment-status
 * subscription, so there is nothing upstream to forward: closing the loop means polling.
 * The question is only *who* polls. Doing it here rather than in the browser means one
 * Railway request per user regardless of how many components would have asked, keeps the
 * access token on the server, and lets a hidden tab cost exactly nothing — the client
 * closes this connection on `visibilitychange` and reopens it on the way back.
 *
 * The payload is a single bit. This endpoint never carries application state; the client
 * answers with router.refresh() and the page re-renders through the normal RSC path, which
 * is the only place that knows how to render it. See ADR-10.
 *
 * There are now two reasons to send that bit, and neither of them carries anything.
 * `changed` means the service set moved. `stale` means the usage readouts have aged past
 * METRICS_POLL_MS — they are read on the render rather than polled, so on a project where
 * nothing changes they would otherwise sit at whatever they were when the page loaded.
 *
 * The staleness clock lives here rather than in the browser precisely because this side
 * knows something the browser does not: whether anything is *running* to be stale about. An
 * environment of stopped containers produces no nudge and therefore no requests, where a
 * setInterval in the hook would fire regardless and spend the same quota to re-render numbers
 * that cannot have moved.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  // Same reasoning as the stream route: the poll loop is created inside this scope, and
  // AsyncLocalStorage captures the store at creation, so a tick fourteen minutes later
  // still carries the request id.
  return withRequestScope("/api/watch/[projectId]", { trustInboundId: true }, () =>
    handle(request, context),
  );
}

async function handle(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await context.params;
  const environmentId = request.nextUrl.searchParams.get("environment") ?? "";

  // Neither id is logged: both are unbounded strings straight off the URL.
  if (!RAILWAY_ID_PATTERN.test(projectId) || !RAILWAY_ID_PATTERN.test(environmentId)) {
    log.warn("watch.rejected", { reason: "invalid_id" });
    return new Response("Bad Request", { status: 400 });
  }

  const session = await requireSessionOrUnauthorized("watch.rejected");
  if (session instanceof Response) return session;

  const t = await getTranslations();

  /*
   * A separate budget from the log streams, in the same map. `acquireStreamSlot` takes an
   * arbitrary key and a limit, so namespacing the key is all it costs — no change to a
   * module that has its own tests, and a tab full of open log panes cannot starve the
   * watcher or the other way round.
   */
  const release = acquireStreamSlot(`watch:${session.user.id}`, WATCH.MAX_PER_USER);
  if (!release) {
    log.warn("watch.rejected", { reason: "slot_limit", limit: WATCH.MAX_PER_USER });
    return new Response("Too Many Watchers", { status: 429 });
  }

  const accessToken = session.accessToken;
  log.info("watch.opened", { project_id: projectId, environment_id: environmentId });
  return sseResponse(
    async (emit, signal) => {
      let previous: string | null = null;
      const base = env().WATCH_POLL_MS;
      const staleAfter = env().METRICS_POLL_MS;
      let interval = base;
      let consecutiveFailures = 0;
      /*
       * When this tab last had a reason to re-render, which is what "stale" is measured
       * from — not when a metrics request last went out. Any refresh re-reads metrics
       * through the RSC path, so a `changed` is as good as a `stale` and resets this too.
       */
      let lastEmit = Date.now();

      while (!signal.aborted) {
        try {
          const { containers } = await getProjectContainers(
            accessToken,
            projectId,
            environmentId,
            signal,
          );
          const next = fingerprint(containers);

          // The first poll establishes the baseline. Announcing a change against nothing
          // would refresh every tab the moment it connected, for no reason.
          if (previous === null) {
            emit.send("ready", { services: containers.length });
            lastEmit = Date.now();
          } else if (next !== previous) {
            emit.send("changed", {});
            lastEmit = Date.now();
          } else if (
            /*
             * Nothing changed, so the only thing that can have gone out of date is the
             * usage readout. Three conditions, and each one is a whole class of wasted
             * request: disabled outright, still fresh, or an environment where nothing is
             * running and the numbers are all em dashes anyway.
             *
             * Deliberately in the `else` — a tick that already sent `changed` has caused
             * the refresh this would have asked for, and sending both would be two events
             * for one render.
             */
            staleAfter > 0 &&
            Date.now() - lastEmit >= staleAfter &&
            containers.some((container) => container.state === "running")
          ) {
            emit.send("stale", {});
            lastEmit = Date.now();
          }

          previous = next;
          interval = base;
          consecutiveFailures = 0;
        } catch (error) {
          if (signal.aborted) return;

          if (error instanceof RailwayApiError && error.kind === "auth") {
            /*
             * The access token was captured when this stream opened, and the proxy
             * refreshes on navigations — which a held response is not. An *expiry* is
             * handled by the duration ceiling below instead, which streamDurationMs clamps
             * to whatever is left of that token: the connection closes, the browser
             * reconnects, and requireSession mints a fresh one. Reaching here means the
             * authorization was revoked or never covered this project, and silently
             * retrying either just burns quota.
             */
            emit.send("error", { message: t("errors.sessionExpired") });
            return;
          }

          // Same shape as the deployment monitor: the transition is worth a warning, the
          // steady state is not. A fifteen-minute outage costs two lines, not sixty.
          consecutiveFailures += 1;
          const fields = {
            project_id: projectId,
            consecutive: consecutiveFailures,
            error,
          };
          if (consecutiveFailures === 1) log.warn("watch.poll_failed", fields);
          else log.debug("watch.poll_failed", fields);

          interval = Math.min(interval * 2, WATCH.MAX_POLL_MS);
        }

        // Jittered so tabs opened together do not converge on the same second.
        await sleep(interval * (1 + (Math.random() - 0.5) * WATCH.JITTER), signal);
      }
    },
    {
      // Bounded by the token this loop polls with, not only by the transport's ceiling —
      // the branch above depends on it. See streamDurationMs.
      maxDurationMs: streamDurationMs(session),
      clientSignal: request.signal,
      onClose: streamCloser("watch.closed", release, ({ reason, durationMs }) => ({
        project_id: projectId,
        reason,
        duration_ms: durationMs,
      })),
    },
  );
}
