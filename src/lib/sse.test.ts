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
});
