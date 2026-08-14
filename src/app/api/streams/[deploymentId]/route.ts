import { type NextRequest } from "next/server";
import { getTranslations } from "next-intl/server";
import { requireSession } from "@/lib/auth/server";
import { monitorDeployment } from "@/lib/railway/deployment-monitor";
import { sseResponse } from "@/lib/sse";
import { log } from "@/lib/logger";
import { withRequestScope } from "@/lib/log/request-scope";
import { streamCloser, streamDurationMs } from "@/lib/stream-route";
import { acquireStreamSlot } from "@/lib/stream-slots";
import { STREAM } from "@/lib/constants";
import { RAILWAY_ID_PATTERN } from "@/lib/validation";
import type { RailwaySession } from "@/lib/auth/session";

// `ws` needs Node, and this is a long-lived response.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Streams one deployment's status and logs to the browser.
 *
 * SSE rather than WebSocket downstream: Next's App Router cannot accept WebSocket
 * upgrades in a route handler, and the browser only needs one direction. The upstream
 * connection to Railway *is* a WebSocket subscription — see deployment-monitor.ts.
 *
 * This handler owns authentication and wiring only. Transport lives in lib/sse.ts and
 * the poll-plus-subscribe merge lives in the monitor.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ deploymentId: string }> },
) {
  /*
   * The scope wraps the whole handler, not just the auth prelude, and that is
   * load-bearing rather than tidy. `new ReadableStream({ start })` runs `start`
   * synchronously during construction — so the monitor's generator, its status poll
   * loop and its drain timer are all created inside this scope, and AsyncLocalStorage
   * captures the store when an async resource is created rather than when it runs. A
   * poll firing fourteen minutes after this function returned still carries the id.
   */
  return withRequestScope("/api/streams/[deploymentId]", { trustInboundId: true }, () =>
    handle(request, context),
  );
}

async function handle(
  request: NextRequest,
  context: { params: Promise<{ deploymentId: string }> },
) {
  const { deploymentId } = await context.params;
  const phase =
    request.nextUrl.searchParams.get("phase") === "build" ? "build" : "deploy";

  // Before anything expensive: an unbounded identifier from the URL used to reach the
  // GraphQL layer and open an upstream socket on the strength of nothing.
  if (!RAILWAY_ID_PATTERN.test(deploymentId)) {
    /*
     * The id itself is not logged. It is an unbounded, attacker-controlled string
     * straight off the URL — the suite feeds this branch "../../etc/passwd" — and putting
     * it in a record an operator greps is the injection surface the validator exists to
     * close. The length carries the diagnostic content: a truncation bug and a probe look
     * different, which is the only question this line has to answer.
     */
    log.warn("stream.rejected", {
      reason: "invalid_deployment_id",
      id_length: deploymentId.length,
    });
    return new Response("Bad Request", { status: 400 });
  }

  let session: RailwaySession;
  try {
    session = await requireSession();
  } catch {
    // debug: a browser whose session just expired retries the EventSource in a loop, so
    // at info this would be the noisiest line in the system.
    log.debug("stream.rejected", { reason: "unauthenticated" });
    return new Response("Unauthorized", { status: 401 });
  }

  // Resolved before the slot is taken: nothing between acquiring and returning the
  // response may throw, or the slot is stranded until the process restarts.
  const t = await getTranslations();

  const release = acquireStreamSlot(session.user.id);
  if (!release) {
    /*
     * warn, not debug: constants.ts already says out loud that a false 429 presents as a
     * log pane that never connects and never explains itself. This is the line that turns
     * that from a support conversation into a query.
     */
    log.warn("stream.rejected", {
      reason: "slot_limit",
      limit: STREAM.MAX_CONCURRENT_PER_USER,
      deployment_id: deploymentId,
    });
    /*
     * 200 with a named error, not 429.
     *
     * A 429 is the honest HTTP answer, but it reaches the browser as an unlabelled
     * EventSource failure: there is no status code on the event, so the client can tell
     * the refusal is fatal and nothing more. This is the one refusal with an action
     * attached to it — close a log panel — and it is worth a sentence.
     *
     * 400 and 401 keep their status codes. Neither is the user's to fix, and the
     * readyState guard in use-deployment-stream stops both from hanging.
     */
    return sseResponse(
      async (emit) => {
        emit.send("error", { message: t("errors.streamLimit") });
      },
      { clientSignal: request.signal },
    );
  }

  const accessToken = session.accessToken;

  log.info("stream.opened", { deployment_id: deploymentId, phase });

  return sseResponse(
    async (emit, signal) => {
      for await (const event of monitorDeployment({
        accessToken,
        deploymentId,
        phase,
        signal,
      })) {
        const { type, ...payload } = event;
        /*
         * The monitor names messages; this is the first layer with a request scope, so
         * it is where a key becomes a sentence. The wire format stays `{ message }`.
         *
         * Container stdout is never re-logged here or anywhere else. It is the user's
         * data, it is unbounded, and re-emitting it would multiply this deployment's own
         * log volume by every stream open. Stated because it is the most tempting wrong
         * thing to add to this loop later.
         */
        emit.send(
          type,
          "message" in event
            ? {
                ...payload,
                message: t(
                  event.message.key as Parameters<typeof t>[0],
                  event.message.values as never,
                ),
              }
            : payload,
        );
        if (type === "done" || type === "error") return;
      }
    },
    // onClose rather than a finally in the producer: the transport runs it on every
    // teardown path, including the one where the producer never returns at all.
    {
      // The token above is captured once and never renewed for the life of this response,
      // so the response may not outlive it. See streamDurationMs.
      maxDurationMs: streamDurationMs(session),
      clientSignal: request.signal,
      // `reason` is what makes this worth having: a stream that ended because the tab
      // closed and one that hit the duration ceiling are the same line otherwise, and
      // only the second is a problem.
      onClose: streamCloser("stream.closed", release, ({ reason, durationMs }) => ({
        deployment_id: deploymentId,
        phase,
        reason,
        duration_ms: durationMs,
      })),
    },
  );
}
