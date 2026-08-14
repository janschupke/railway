import "server-only";

import { createClient, type Client } from "graphql-ws";
import WebSocket from "ws";
import { railwayWsUrl } from "./client";
import type { TypedDocument } from "./typed-document";
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

/** Which of the two log subscriptions a stream is reading. */
export type LogSubscriptionField = "buildLogs" | "deploymentLogs";

/**
 * Either log subscription, as a document that carries its own types.
 *
 * `Partial` because each of the two documents selects one of the fields and the generated
 * types say so — `StreamBuildLogsSubscription` has no `deploymentLogs` member. What this
 * buys is that nothing else can be passed here: a plain string is no longer a document, so
 * the query and the field cannot come from two unrelated places.
 */
export type LogSubscriptionDocument = TypedDocument<
  Partial<Record<LogSubscriptionField, LogLine[]>>,
  { deploymentId: string }
>;

/**
 * Async iterator over one log subscription. Terminates when the caller aborts, when
 * Railway completes the subscription, or on socket error.
 */
export async function* streamLogs(
  client: Client,
  document: LogSubscriptionDocument,
  field: LogSubscriptionField,
  deploymentId: string,
  signal: AbortSignal,
): AsyncGenerator<LogLine> {
  /*
   * Deliberately looser than the document's own type, which says `[Log!]!`.
   *
   * The batching below was written against an undocumented transport rather than against
   * the schema — a single push that is not an array has never been proved impossible, and
   * the schema is a claim about the field, not about what graphql-ws hands over. Narrowing
   * this to the generated array type would delete a runtime guard to satisfy a type.
   */
  const iterator = client.iterate<
    Record<LogSubscriptionField, LogLine[] | LogLine | null>
  >({ query: document, variables: { deploymentId } });

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
