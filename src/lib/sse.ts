import { STREAM } from "@/lib/constants";

export type SseEmitter = {
  /** Emit a named event with a JSON payload. No-op once closed. */
  send: (event: string, data: unknown) => void;
  /** End the stream. Idempotent. */
  close: () => void;
};

export type SseOptions = {
  keepaliveMs?: number;
  maxDurationMs?: number;
  /** Aborts when the client disconnects. */
  clientSignal?: AbortSignal;
};

/**
 * Server-sent events transport. Knows nothing about deployments.
 *
 * Owns the three things every SSE endpoint gets wrong: keepalive comment frames so
 * intermediaries do not idle out a quiet stream, a hard duration ceiling so a wedged
 * producer cannot pin a connection forever, and teardown that runs exactly once
 * whichever side hangs up first.
 */
export function sseResponse(
  produce: (emit: SseEmitter, signal: AbortSignal) => Promise<void>,
  options: SseOptions = {},
): Response {
  const {
    keepaliveMs = STREAM.KEEPALIVE_MS,
    maxDurationMs = STREAM.MAX_DURATION_MS,
    clientSignal,
  } = options;

  const encoder = new TextEncoder();
  const controller = new AbortController();

  clientSignal?.addEventListener("abort", () => controller.abort(), { once: true });
  const deadline = setTimeout(() => controller.abort(), maxDurationMs);

  const stream = new ReadableStream<Uint8Array>({
    async start(streamController) {
      let closed = false;

      const enqueue = (chunk: string) => {
        if (closed) return;
        try {
          streamController.enqueue(encoder.encode(chunk));
        } catch {
          // The consumer went away between the check and the write.
          closed = true;
        }
      };

      const keepalive = setInterval(() => enqueue(": keepalive\n\n"), keepaliveMs);

      const emit: SseEmitter = {
        send: (event, data) =>
          enqueue(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        close: () => {
          if (closed) return;
          closed = true;
          clearTimeout(deadline);
          clearInterval(keepalive);
          controller.abort();
          try {
            streamController.close();
          } catch {
            // Already closed by the runtime.
          }
        },
      };

      controller.signal.addEventListener("abort", emit.close, { once: true });

      try {
        await produce(emit, controller.signal);
      } finally {
        emit.close();
      }
    },

    cancel() {
      clearTimeout(deadline);
      controller.abort();
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
