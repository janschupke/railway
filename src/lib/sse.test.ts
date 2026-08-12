import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
});
