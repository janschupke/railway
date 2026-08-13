import { STREAM } from "@/lib/constants";

export type SseEmitter = {
  /** Emit a named event with a JSON payload. No-op once closed. */
  send: (event: string, data: unknown) => void;
  /** End the stream. Idempotent. */
  close: () => void;
};

/**
 * Which teardown path ended the stream.
 *
 * Reported rather than logged: deciding that a `deadline` close is worth a warning and a
 * `client-abort` is not belongs to the route, which knows what it opened the stream for.
 * This module stays a transport with no opinion and no logger import.
 */
type SseCloseReason =
  | "producer" // the producer returned normally
  | "producer-error" // the producer threw
  | "client-abort" // clientSignal fired — the browser went away
  | "deadline" // maxDurationMs elapsed
  | "cancel"; // ReadableStream.cancel(), the runtime's own hangup path

// Not exported: callers destructure it off `onClose`'s parameter and never name it, and
// an export nothing imports is a knip failure.
type SseCloseInfo = { reason: SseCloseReason; durationMs: number };

/**
 * One definition, because both exits have to send them.
 *
 * The content type is what makes a response an event stream to the browser; anything
 * else, 204 included, is a fatal error to EventSource rather than a stream that ended.
 */
const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  // Defensive: stops any nginx-style proxy from buffering the stream.
  "x-accel-buffering": "no",
} as const;

export type SseOptions = {
  keepaliveMs?: number;
  maxDurationMs?: number;
  /** Aborts when the client disconnects. */
  clientSignal?: AbortSignal;
  /**
   * Runs exactly once, on whichever teardown path fires first.
   *
   * Belongs here rather than in the producer: a producer that failed to observe its
   * abort signal would never return, so a `finally` in the caller would never run and
   * whatever it releases would leak for the life of the process.
   */
  onClose?: (info: SseCloseInfo) => void;
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
    onClose,
  } = options;

  const encoder = new TextEncoder();
  const controller = new AbortController();

  const startedAt = Date.now();
  let reason: SseCloseReason | null = null;
  /*
   * First writer wins, and `??=` is what makes that safe: a client disconnect fires both
   * `clientSignal` and `cancel()`, so the second call has to be a no-op — the same
   * property `emit.close()`'s own `closed` flag has. Every caller claims on the line
   * *before* `controller.abort()`, so the reason is set by the time `emit.close` runs
   * synchronously inside the abort.
   */
  const claim = (next: SseCloseReason) => {
    reason ??= next;
  };

  /*
   * Checked before the listener, because `addEventListener` never fires for a signal that
   * has already aborted — and by the time a route reaches this line it has awaited three
   * times (the route params, requireSession, getTranslations). A browser that gave up
   * during those awaits arrived here with an already-dead signal, nothing listening, and
   * therefore no teardown until maxDurationMs: fifteen minutes holding a stream slot, an
   * upstream Railway socket and a 2.5s status poll for a tab that had closed. Four of
   * those and the user cannot open a log pane at all.
   *
   * Returning early rather than constructing the stream keeps `produce` from ever running,
   * so there is no upstream socket to unwind.
   *
   * It is still an event-stream response, and that part is not cosmetic. A 204, or any
   * response without this content type, is a *fatal* condition to EventSource: it fires
   * `error` and gives up permanently rather than reconnecting. An immediately-finished
   * stream is the case EventSource already handles by reconnecting, which is exactly
   * what a client that is in fact still there should get.
   */
  if (clientSignal?.aborted) {
    claim("client-abort");
    controller.abort();
    onClose?.({ reason: "client-abort", durationMs: 0 });
    return new Response("", { headers: SSE_HEADERS });
  }

  clientSignal?.addEventListener(
    "abort",
    () => {
      claim("client-abort");
      controller.abort();
    },
    { once: true },
  );
  const deadline = setTimeout(() => {
    claim("deadline");
    controller.abort();
  }, maxDurationMs);

  const stream = new ReadableStream<Uint8Array>({
    async start(streamController) {
      let closed = false;

      /*
       * Declared before `enqueue`, which is what lets a failed write funnel through it.
       * The single funnel for every teardown path, which is what makes onClose
       * exactly-once without a second guard.
       */
      const close = () => {
        if (closed) return;
        closed = true;

        /*
         * Timers first, onClose second. It used to be the other way round, and both
         * callers' onClose does real work — release() plus a pino write to stdout. A throw
         * anywhere in there skipped every line below it: the keepalive kept firing on a
         * dead socket for the life of the process, holding the event loop open, while
         * enqueue silently no-op'd and the slot the callback was about to release stayed
         * taken. Clearing first means the transport is inert before any caller code runs.
         */
        clearTimeout(deadline);
        clearInterval(keepalive);
        controller.abort();
        try {
          streamController.close();
        } catch {
          // Already closed by the runtime.
        }

        try {
          onClose?.({
            reason: reason ?? "producer",
            durationMs: Date.now() - startedAt,
          });
        } catch {
          /*
           * Swallowed, not logged: this module is a transport with no logger import by
           * design (see the SseCloseReason docblock). A caller whose teardown throws has
           * a defect of its own, but it must not take the close path down with it.
           */
        }
      };

      const enqueue = (chunk: string) => {
        if (closed) return;
        try {
          streamController.enqueue(encoder.encode(chunk));
        } catch {
          /*
           * The consumer went away between the check and the write.
           *
           * This used to set the `closed` flag and return, which silenced the transport
           * but ran no teardown: onClose never fired, so the caller's slot was never
           * released, the keepalive kept firing and the producer kept polling Railway
           * for the full duration ceiling. Eight of those and the user is 429'd
           * permanently — which presents as a log pane that never connects.
           */
          claim("client-abort");
          close();
        }
      };

      /*
       * Declared after the two closures that reference it. Safe because nothing calls
       * either of them synchronously before this line, and it keeps the binding const —
       * an interval handle that could be reassigned is a second way to leak one.
       */
      const keepalive = setInterval(() => enqueue(": keepalive\n\n"), keepaliveMs);

      const emit: SseEmitter = {
        send: (event, data) =>
          enqueue(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        close,
      };

      /*
       * Registered synchronously, before the first await below. That is load-bearing:
       * `cancel()` aborts this controller, and if the listener were attached after
       * `produce` started, a client that vanished during the first tick would abort
       * before anything was listening and teardown would never run.
       */
      controller.signal.addEventListener("abort", close, { once: true });

      try {
        await produce(emit, controller.signal);
        claim("producer");
      } catch (error) {
        // Claimed before the rethrow, and `??=` means an abort that already named the
        // close still wins — a producer throwing *because* it was aborted is not news.
        claim("producer-error");
        throw error;
      } finally {
        emit.close();
      }
    },

    cancel() {
      claim("cancel");
      clearTimeout(deadline);
      controller.abort();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
