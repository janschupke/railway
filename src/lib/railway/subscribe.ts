import "server-only";

import { createClient, type Client } from "graphql-ws";
import WebSocket from "ws";
import { railwayWsUrl } from "./client";
import type { LogLine } from "./types";

/**
 * Railway streams build and deploy logs as GraphQL subscriptions over
 * `wss://backboard.railway.com/graphql/v2` — the same transport their CLI uses for
 * `railway logs`. This is a genuine push stream, not a poll.
 *
 * The token is sent two ways because Railway's expectation is undocumented: as an
 * `Authorization` header on the upgrade request (possible here because this runs in
 * Node with `ws`, unlike a browser), and in `connectionParams` on connection_init.
 */
function authedSocket(accessToken: string) {
  return class extends WebSocket {
    constructor(address: string | URL, protocols?: string | string[]) {
      super(address, protocols, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    }
  } as unknown as typeof WebSocket;
}

export function createLogClient(accessToken: string): Client {
  return createClient({
    url: railwayWsUrl(),
    webSocketImpl: authedSocket(accessToken),
    connectionParams: { Authorization: `Bearer ${accessToken}` },
    // The SSE route owns reconnection policy; keep the socket layer simple.
    retryAttempts: 2,
    shouldRetry: () => true,
  });
}

/**
 * Async iterator over one log subscription. Terminates when the caller aborts, when
 * Railway completes the subscription, or on socket error.
 */
export async function* streamLogs(
  client: Client,
  document: string,
  field: "buildLogs" | "deploymentLogs",
  deploymentId: string,
  signal: AbortSignal,
): AsyncGenerator<LogLine> {
  const iterator = client.iterate<Record<string, LogLine[] | LogLine | null>>({
    query: document,
    variables: { deploymentId },
  });

  const onAbort = () => void iterator.return?.(undefined);
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    for await (const result of iterator) {
      if (signal.aborted) return;
      const payload = result.data?.[field];
      if (!payload) continue;
      // Railway batches log lines; a single push can carry many.
      const lines = Array.isArray(payload) ? payload : [payload];
      for (const line of lines) yield line;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
