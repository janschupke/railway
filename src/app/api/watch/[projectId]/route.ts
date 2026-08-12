import { type NextRequest } from "next/server";
import { getTranslations } from "next-intl/server";
import { requireSession } from "@/lib/auth/server";
import { getProjectContainers } from "@/lib/railway/api";
import { RailwayApiError } from "@/lib/railway/errors";
import { fingerprint } from "@/lib/railway/watch-fingerprint";
import { sseResponse } from "@/lib/sse";
import { log } from "@/lib/logger";
import { withRequestScope } from "@/lib/log/request-scope";
import { requestContext, runWithRequestContext } from "@/lib/log/context";
import { acquireStreamSlot } from "@/lib/stream-slots";
import { WATCH } from "@/lib/constants";
import { env } from "@/env";
import { RAILWAY_ID_PATTERN } from "@/lib/validation";
import type { RailwaySession } from "@/lib/auth/session";

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
 * answers `changed` with router.refresh() and the page re-renders through the normal RSC
 * path, which is the only place that knows how to render it. See ADR-10.
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

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

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

  let session: RailwaySession;
  try {
    session = await requireSession();
  } catch {
    // debug: a tab whose session just expired reopens this in a loop.
    log.debug("watch.rejected", { reason: "unauthenticated" });
    return new Response("Unauthorized", { status: 401 });
  }

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
  const scope = requestContext();

  return sseResponse(
    async (emit, signal) => {
      let previous: string | null = null;
      const base = env().WATCH_POLL_MS;
      let interval = base;
      let consecutiveFailures = 0;

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
          if (previous === null) emit.send("ready", { services: containers.length });
          else if (next !== previous) emit.send("changed", {});

          previous = next;
          interval = base;
          consecutiveFailures = 0;
        } catch (error) {
          if (signal.aborted) return;

          if (error instanceof RailwayApiError && error.kind === "auth") {
            /*
             * The access token was captured when this stream opened, and the proxy
             * refreshes on navigations — which a held response is not. An *expiry* is
             * handled by sseResponse's fifteen-minute ceiling instead: the connection
             * closes, the browser reconnects, and requireSession mints a fresh token.
             * Reaching here means the authorization was revoked, and silently retrying a
             * revoked grant just burns quota.
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
      clientSignal: request.signal,
      onClose: ({ reason, durationMs }) => {
        release();
        const record = () =>
          log.info("watch.closed", {
            project_id: projectId,
            reason,
            duration_ms: durationMs,
          });
        if (scope) runWithRequestContext(scope, record);
        else record();
      },
    },
  );
}
