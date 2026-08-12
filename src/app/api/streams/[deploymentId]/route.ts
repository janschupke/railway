import { type NextRequest } from "next/server";
import { getTranslations } from "next-intl/server";
import { requireSession } from "@/lib/auth/server";
import { monitorDeployment } from "@/lib/railway/deployment-monitor";
import { sseResponse } from "@/lib/sse";
import { acquireStreamSlot } from "@/lib/stream-slots";
import { DEPLOYMENT_ID_PATTERN } from "@/lib/validation";
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
  const { deploymentId } = await context.params;
  const phase =
    request.nextUrl.searchParams.get("phase") === "build" ? "build" : "deploy";

  // Before anything expensive: an unbounded identifier from the URL used to reach the
  // GraphQL layer and open an upstream socket on the strength of nothing.
  if (!DEPLOYMENT_ID_PATTERN.test(deploymentId)) {
    return new Response("Bad Request", { status: 400 });
  }

  let session: RailwaySession;
  try {
    session = await requireSession();
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  // Resolved before the slot is taken: nothing between acquiring and returning the
  // response may throw, or the slot is stranded until the process restarts.
  const t = await getTranslations();

  const release = acquireStreamSlot(session.user.id);
  if (!release) {
    return new Response("Too Many Streams", {
      status: 429,
      headers: { "retry-after": "5" },
    });
  }

  const accessToken = session.accessToken;

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
    { clientSignal: request.signal, onClose: release },
  );
}
