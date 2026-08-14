import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestContext, runWithRequestContext } from "@/lib/log/context";
import { sseResponse } from "./sse";

async function readAll(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

describe("sseResponse", () => {
  it("sets the headers a streaming response needs", () => {
    const response = sseResponse(async (emit) => emit.close());

    expect(response.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    // Without this, an nginx-style proxy buffers the whole stream and nothing
    // reaches the browser until the deployment finishes.
    expect(response.headers.get("x-accel-buffering")).toBe("no");
  });

  it("frames events in SSE wire format", async () => {
    const response = sseResponse(async (emit) => {
      emit.send("status", { state: "running" });
      emit.close();
    });

    expect(await readAll(response)).toBe(
      'event: status\ndata: {"state":"running"}\n\n',
    );
  });

  it("closes when the producer returns, without an explicit close", async () => {
    const response = sseResponse(async (emit) => {
      emit.send("done", { ok: true });
    });

    expect(await readAll(response)).toContain("event: done");
  });

  it("drops writes after close instead of throwing", async () => {
    const response = sseResponse(async (emit) => {
      emit.send("first", 1);
      emit.close();
      emit.send("second", 2);
    });

    const body = await readAll(response);
    expect(body).toContain("first");
    expect(body).not.toContain("second");
  });

  it("survives a double close", async () => {
    const response = sseResponse(async (emit) => {
      emit.close();
      emit.close();
    });
    await expect(readAll(response)).resolves.toBe("");
  });

  describe("with fake timers", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("emits keepalive comments while the producer is quiet", async () => {
      let release: (() => void) | undefined;
      const response = sseResponse(
        async () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
        { keepaliveMs: 100 },
      );

      const body = readAll(response);
      await vi.advanceTimersByTimeAsync(350);
      release?.();

      // Comment frames, not events — they keep intermediaries from idling out.
      expect((await body).match(/: keepalive/g)?.length).toBeGreaterThanOrEqual(3);
    });

    it("aborts the producer at the duration ceiling", async () => {
      let aborted = false;
      const response = sseResponse(
        async (_emit, signal) => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve()),
          );
        },
        { maxDurationMs: 500, keepaliveMs: 10_000 },
      );

      const body = readAll(response);
      await vi.advanceTimersByTimeAsync(600);
      await body;

      // A wedged build must not pin the connection indefinitely.
      expect(aborted).toBe(true);
    });

    it("aborts when the client disconnects", async () => {
      const client = new AbortController();
      let aborted = false;

      const response = sseResponse(
        async (_emit, signal) => {
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => {
              aborted = true;
              resolve();
            }),
          );
        },
        { clientSignal: client.signal, keepaliveMs: 10_000 },
      );

      const body = readAll(response);
      client.abort();
      await vi.advanceTimersByTimeAsync(10);
      await body;

      expect(aborted).toBe(true);
    });
  });

  /*
   * onClose is what releases a stream slot, so "exactly once, on every path" is a
   * correctness property rather than a nicety: miss a path and the user is locked out
   * of their own log panes until the process restarts; double-fire and the cap can be
   * walked past. Every teardown route the transport has is enumerated here.
   */
  describe("onClose", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("runs when the producer finishes normally", async () => {
      let closes = 0;
      const response = sseResponse(async (emit) => emit.send("done", {}), {
        onClose: () => closes++,
        keepaliveMs: 10_000,
      });

      await readAll(response);
      expect(closes).toBe(1);
    });

    it("runs once even when the producer closes explicitly first", async () => {
      let closes = 0;
      const response = sseResponse(
        async (emit) => {
          emit.close();
          emit.close();
        },
        { onClose: () => closes++, keepaliveMs: 10_000 },
      );

      await readAll(response);
      expect(closes).toBe(1);
    });

    it("runs when the client disconnects", async () => {
      let closes = 0;
      const client = new AbortController();
      const response = sseResponse(
        async (_emit, signal) =>
          new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve()),
          ),
        { clientSignal: client.signal, onClose: () => closes++, keepaliveMs: 10_000 },
      );

      const body = readAll(response);
      client.abort();
      await vi.advanceTimersByTimeAsync(10);
      await body;

      expect(closes).toBe(1);
    });

    it("runs at the duration ceiling, even if the producer never returns", async () => {
      // The reason onClose lives in the transport and not in a producer `finally`.
      let closes = 0;
      const response = sseResponse(async () => new Promise<void>(() => {}), {
        maxDurationMs: 500,
        keepaliveMs: 10_000,
        onClose: () => closes++,
      });

      readAll(response);
      await vi.advanceTimersByTimeAsync(600);

      expect(closes).toBe(1);
    });

    it("runs when the client had already gone before the stream was built", async () => {
      /*
       * addEventListener never fires for a signal that has already aborted, and a route
       * awaits three times before it gets here — params, requireSession, getTranslations.
       * A browser that gave up during those arrived with a dead signal and nothing
       * listening, so the only remaining teardown was maxDurationMs: fifteen minutes
       * holding a slot, an upstream socket and a status poll for a tab that had closed.
       */
      const client = new AbortController();
      client.abort();

      let produced = false;
      const seen: Array<{ reason: string; durationMs: number }> = [];
      const response = sseResponse(
        async () => {
          produced = true;
        },
        {
          clientSignal: client.signal,
          keepaliveMs: 10_000,
          onClose: (info) => void seen.push(info),
        },
      );

      await vi.advanceTimersByTimeAsync(10);

      expect(seen).toHaveLength(1);
      expect(seen[0]?.reason).toBe("client-abort");
      // Never started, so there is no upstream socket to unwind.
      expect(produced).toBe(false);
      /*
       * Still an event stream, and not a 204. Anything without this content type is a
       * fatal condition to EventSource — it fires `error` and stops reconnecting — where
       * a stream that simply finished is the case it already handles. Getting this wrong
       * turned a reconnect into a dead watcher, which showed up as a list that stopped
       * responding rather than as anything resembling a stream defect.
       */
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "text/event-stream; charset=utf-8",
      );
      expect(await response.text()).toBe("");
    });

    it("clears its timers even when the caller's teardown throws", async () => {
      /*
       * onClose used to run before the clears. Both callers do real work in it —
       * release() plus a pino write — and a throw skipped every line below: the keepalive
       * kept firing on a dead socket for the life of the process while enqueue silently
       * no-op'd, and the slot that callback was about to release stayed taken.
       */
      const response = sseResponse(async (emit) => emit.send("done", {}), {
        keepaliveMs: 100,
        maxDurationMs: 60_000,
        onClose: () => {
          throw new Error("release blew up");
        },
      });

      await readAll(response).catch(() => {});

      /*
       * Asserted on the timer registry rather than on emitted bytes. `closed` is set
       * before onClose either way, so enqueue no-ops on both versions and the keepalive
       * leaks silently — the surviving handle IS the defect, and it is the only thing
       * that shows it.
       */
      expect(vi.getTimerCount()).toBe(0);
    });

    it("runs when the consumer cancels the stream", async () => {
      /*
       * The path Next takes when a browser tab vanishes, and the one the rest of this
       * suite never exercised. It works only because the abort listener is registered
       * synchronously in start(), before the first await.
       */
      let closes = 0;
      const response = sseResponse(
        async (_emit, signal) =>
          new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve()),
          ),
        { onClose: () => closes++, keepaliveMs: 10_000 },
      );

      await response.body!.cancel();
      await vi.advanceTimersByTimeAsync(10);

      expect(closes).toBe(1);
    });
  });

  it("keeps the producer inside the caller's async context", async () => {
    /*
     * The property the entire correlation design rests on, and one that fails silently:
     * records would simply lack request_id and nothing would break.
     *
     * `new ReadableStream({ start })` runs `start` synchronously during construction, so
     * `produce` — and every timer the deployment monitor creates inside it — is an async
     * resource created while the route handler's scope is still open. AsyncLocalStorage
     * captures the store at creation, not at execution, which is why a status poll firing
     * fourteen minutes later still carries the id. A refactor that deferred `produce` to
     * a later tick would break this and pass every other test in this file.
     */
    const seen: Array<string | undefined> = [];

    await runWithRequestContext({ requestId: "scoped" }, async () => {
      const response = sseResponse(
        async (emit) => {
          seen.push(requestContext()?.requestId);
          await new Promise((resolve) => setTimeout(resolve, 1));
          seen.push(requestContext()?.requestId);
          emit.send("done", {});
        },
        {
          keepaliveMs: 10_000,
          onClose: () => void seen.push(requestContext()?.requestId),
        },
      );
      await readAll(response);
    });

    expect(seen).toEqual(["scoped", "scoped", "scoped"]);
  });

  it("loses the context on the abort teardown paths, which callers must handle", async () => {
    /*
     * The limit of the property above, found by reading real e2e output rather than by
     * reasoning: teardown carries the context only when the trigger fires inside it. A
     * client hangup does not — the abort arrives from the runtime after the handler has
     * returned, and the listener runs in whatever context aborted it. `stream.closed`
     * came out with no request_id, unjoinable to the `stream.opened` it belonged to.
     *
     * Fixing it inside the transport would mean importing the log context here, which is
     * exactly the coupling this module does not have. The route captures the context and
     * re-enters it instead; this test is what stops someone assuming it is unnecessary.
     */
    let seen: string | undefined = "unset";
    const client = new AbortController();

    // Constructed in scope, exactly as the route does…
    const response = runWithRequestContext({ requestId: "scoped" }, () =>
      sseResponse(
        async (_emit, signal) =>
          new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve()),
          ),
        {
          clientSignal: client.signal,
          keepaliveMs: 10_000,
          onClose: () => void (seen = requestContext()?.requestId),
        },
      ),
    );

    const body = readAll(response);
    // …then aborted from outside it, as the runtime does when the socket closes.
    client.abort();
    await body;

    expect(seen).toBeUndefined();
  });

  /*
   * The reason is what makes stream.closed worth logging at all: a tab closing and the
   * fifteen-minute ceiling firing are otherwise the same line, and only one of them is a
   * problem. Every path names itself, and the naming must not disturb the exactly-once
   * property above — hence the double-fire case at the end.
   */
  describe("close reason", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    const closeInfo = () => {
      const seen: Array<{ reason: string; durationMs: number }> = [];
      return {
        seen,
        onClose: (info: { reason: string; durationMs: number }) => void seen.push(info),
      };
    };

    it("names a producer that returned", async () => {
      const { seen, onClose } = closeInfo();
      await readAll(
        sseResponse(async (emit) => emit.send("done", {}), {
          onClose,
          keepaliveMs: 10_000,
        }),
      );

      expect(seen[0]?.reason).toBe("producer");
      expect(seen[0]?.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("names a producer that threw", async () => {
      const { seen, onClose } = closeInfo();
      const response = sseResponse(
        async () => {
          throw new Error("upstream gone");
        },
        { onClose, keepaliveMs: 10_000 },
      );

      await readAll(response).catch(() => {});
      await vi.advanceTimersByTimeAsync(10);

      expect(seen[0]?.reason).toBe("producer-error");
    });

    it("names a client that disconnected", async () => {
      const { seen, onClose } = closeInfo();
      const client = new AbortController();
      const response = sseResponse(
        async (_emit, signal) =>
          new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve()),
          ),
        { clientSignal: client.signal, onClose, keepaliveMs: 10_000 },
      );

      const body = readAll(response);
      client.abort();
      await vi.advanceTimersByTimeAsync(10);
      await body;

      expect(seen[0]?.reason).toBe("client-abort");
    });

    it("names the duration ceiling, which is invisible otherwise", async () => {
      const { seen, onClose } = closeInfo();
      const response = sseResponse(
        async (_emit, signal) =>
          new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve()),
          ),
        { onClose, keepaliveMs: 10_000, maxDurationMs: 500 },
      );

      readAll(response);
      await vi.advanceTimersByTimeAsync(600);

      expect(seen[0]?.reason).toBe("deadline");
      expect(seen[0]?.durationMs).toBeGreaterThanOrEqual(500);
    });

    it("names a write that failed, and tears down instead of going quiet", async () => {
      /*
       * The consumer can vanish between `closed`'s check and the write itself, and some
       * runtimes signal that by failing the write rather than by calling cancel(). That
       * branch used to set the `closed` flag and return: the transport went silent, but
       * onClose never ran, so the caller's stream slot was never released, the keepalive
       * kept firing and the producer polled Railway for the full duration ceiling. Eight
       * of those and the user is 429'd out of their own log panes permanently.
       *
       * Simulated at the encoder rather than the controller, because a ReadableStream
       * cannot be driven into "enqueue throws" from the outside without going through
       * cancel() — which is a different teardown path, already covered above.
       */
      const { seen, onClose } = closeInfo();
      let writes = 0;
      const encode = vi
        .spyOn(TextEncoder.prototype, "encode")
        .mockImplementation((() => {
          writes += 1;
          throw new Error("socket gone");
        }) as unknown as TextEncoder["encode"]);

      const response = sseResponse(
        async (emit, signal) => {
          emit.send("status", { state: "building" });
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve()),
          );
        },
        { onClose, keepaliveMs: 100 },
      );

      await readAll(response).catch(() => {});
      const writesAtClose = writes;
      // The keepalive must be cleared by the teardown, not left ticking on a dead socket.
      await vi.advanceTimersByTimeAsync(500);
      encode.mockRestore();

      expect(seen).toHaveLength(1);
      expect(seen[0]?.reason).toBe("client-abort");
      expect(writes).toBe(writesAtClose);
    });

    it("names a consumer cancellation", async () => {
      const { seen, onClose } = closeInfo();
      const response = sseResponse(
        async (_emit, signal) =>
          new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve()),
          ),
        { onClose, keepaliveMs: 10_000 },
      );

      await response.body!.cancel();
      await vi.advanceTimersByTimeAsync(10);

      expect(seen[0]?.reason).toBe("cancel");
    });

    it("lets the first path win when two fire, and still closes once", async () => {
      /*
       * A real disconnect fires clientSignal and then cancel(). `??=` is what makes the
       * second a no-op, matching emit.close()'s own guard — without it the last writer
       * would win and every client disconnect would be reported as a cancellation.
       */
      const { seen, onClose } = closeInfo();
      const client = new AbortController();
      const response = sseResponse(
        async (_emit, signal) =>
          new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve()),
          ),
        { clientSignal: client.signal, onClose, keepaliveMs: 10_000 },
      );

      client.abort();
      await response.body!.cancel();
      await vi.advanceTimersByTimeAsync(10);

      expect(seen).toHaveLength(1);
      expect(seen[0]?.reason).toBe("client-abort");
    });
  });
});
