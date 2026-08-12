import { type NextRequest } from "next/server";
import { requireAccessToken } from "@/lib/auth/server";
import { getDeployment, getLogs } from "@/lib/railway/api";
import {
  BUILD_LOGS_SUBSCRIPTION,
  DEPLOYMENT_LOGS_SUBSCRIPTION,
} from "@/lib/railway/operations";
import { createLogClient, streamLogs } from "@/lib/railway/subscribe";
import { isTerminal, toContainerState } from "@/lib/railway/types";
import { RailwayApiError } from "@/lib/railway/errors";

// `ws` needs Node; this also has to be a long-lived response, so no static analysis.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KEEPALIVE_MS = 15_000;
const STATUS_POLL_MS = 2_500;
/** Give the log subscription a moment to flush after a terminal status. */
const DRAIN_MS = 2_000;
/** Hard ceiling so a wedged build cannot pin a connection forever. */
const MAX_STREAM_MS = 15 * 60 * 1000;

/**
 * Server-sent events carrying one deployment's status transitions and log output.
 *
 * SSE rather than WebSocket downstream: Next's App Router cannot accept WebSocket
 * upgrades in a route handler, and the browser only needs one direction anyway. The
 * upstream connection to Railway *is* a WebSocket subscription, so log lines are
 * pushed rather than polled.
 *
 * Status is the exception — Railway exposes log subscriptions but no deployment-status
 * subscription, so status is polled here. The poll is bounded in a way a dashboard-wide
 * poll would not be: one deployment, only while it is transitioning, and the whole
 * stream closes once it reaches a terminal state.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ deploymentId: string }> },
) {
  const { deploymentId } = await context.params;
  const phase = request.nextUrl.searchParams.get("phase") === "build" ? "build" : "deploy";

  let accessToken: string;
  try {
    accessToken = await requireAccessToken();
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  const encoder = new TextEncoder();
  const abort = new AbortController();
  // Client navigated away or closed the tab.
  request.signal.addEventListener("abort", () => abort.abort(), { once: true });
  const deadline = setTimeout(() => abort.abort(), MAX_STREAM_MS);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };
      const close = () => {
        if (closed) return;
        closed = true;
        clearTimeout(deadline);
        clearInterval(keepalive);
        abort.abort();
        try {
          controller.close();
        } catch {
          // Already closed by the runtime; nothing to do.
        }
      };

      // Comment frames keep proxies from idling the connection out during a long build.
      const keepalive = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(": keepalive\n\n"));
      }, KEEPALIVE_MS);

      abort.signal.addEventListener("abort", close, { once: true });

      try {
        // Backfill first so an attach mid-build does not start from an empty pane.
        const backfill = await getLogs(
          accessToken,
          deploymentId,
          phase,
          200,
          abort.signal,
        );
        for (const line of backfill) send("log", line);
        send("ready", { deploymentId, phase, backfilled: backfill.length });
      } catch (error) {
        // A missing backfill is not fatal — the live stream may still work.
        send("warning", {
          message:
            error instanceof RailwayApiError
              ? error.userMessage()
              : "Could not load earlier logs",
        });
      }

      const pollStatus = async () => {
        try {
          const deployment = await getDeployment(
            accessToken,
            deploymentId,
            abort.signal,
          );
          if (!deployment) return;
          const state = toContainerState(deployment.status);
          send("status", {
            deploymentId,
            state,
            rawStatus: deployment.status,
            updatedAt: deployment.updatedAt,
          });
          if (isTerminal(state)) {
            // Let trailing log frames arrive before hanging up.
            setTimeout(() => {
              send("done", { deploymentId, state });
              close();
            }, DRAIN_MS);
            clearInterval(statusTimer);
          }
        } catch (error) {
          if (error instanceof RailwayApiError && error.kind === "auth") {
            send("error", error.toClientError());
            close();
          }
          // Transient errors: the next tick retries.
        }
      };

      const statusTimer = setInterval(() => void pollStatus(), STATUS_POLL_MS);
      void pollStatus();

      const logClient = createLogClient(accessToken);
      const document =
        phase === "build" ? BUILD_LOGS_SUBSCRIPTION : DEPLOYMENT_LOGS_SUBSCRIPTION;
      const field = phase === "build" ? "buildLogs" : "deploymentLogs";

      try {
        for await (const line of streamLogs(
          logClient,
          document,
          field,
          deploymentId,
          abort.signal,
        )) {
          send("log", line);
        }
      } catch (error) {
        if (!abort.signal.aborted) {
          send("warning", {
            message:
              error instanceof Error
                ? `Log stream interrupted: ${error.message}`
                : "Log stream interrupted",
          });
        }
      } finally {
        clearInterval(statusTimer);
        void logClient.dispose();
      }
    },
    cancel() {
      clearTimeout(deadline);
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Defensive: stops any nginx-style proxy from buffering the stream.
      "x-accel-buffering": "no",
    },
  });
}
