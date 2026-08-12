import { type NextRequest } from "next/server";
import { requireAccessToken } from "@/lib/auth/server";
import { monitorDeployment } from "@/lib/railway/deployment-monitor";
import { sseResponse } from "@/lib/sse";

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

  let accessToken: string;
  try {
    accessToken = await requireAccessToken();
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  return sseResponse(
    async (emit, signal) => {
      for await (const event of monitorDeployment({
        accessToken,
        deploymentId,
        phase,
        signal,
      })) {
        const { type, ...payload } = event;
        emit.send(type, payload);
        if (type === "done" || type === "error") return;
      }
    },
    { clientSignal: request.signal },
  );
}
