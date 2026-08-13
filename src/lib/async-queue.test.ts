import { describe, expect, it } from "vitest";
import { AsyncQueue } from "./async-queue";

async function collect<T>(queue: AsyncQueue<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of queue) out.push(item);
  return out;
}

describe("AsyncQueue", () => {
  it("yields items pushed before iteration starts", async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.end();

    expect(await collect(queue)).toEqual([1, 2]);
  });

  it("yields items pushed while the consumer is waiting", async () => {
    const queue = new AsyncQueue<string>();
    const collected = collect(queue);

    // The consumer is parked on an empty queue at this point.
    await Promise.resolve();
    queue.push("a");
    queue.push("b");
    queue.end();

    expect(await collected).toEqual(["a", "b"]);
  });

  it("drains buffered items before finishing", async () => {
    // end() must not discard work already accepted, or a terminal status could
    // truncate the final log lines.
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.end();

    expect(await collect(queue)).toEqual([1, 2]);
  });

  it("ignores pushes after end", async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.end();
    queue.push(2);

    expect(await collect(queue)).toEqual([1]);
    expect(queue.ended).toBe(true);
  });

  it("is idempotent on repeated end", async () => {
    const queue = new AsyncQueue<number>();
    queue.end();
    queue.end();
    expect(await collect(queue)).toEqual([]);
  });

  it("releases a parked consumer when ended", async () => {
    const queue = new AsyncQueue<number>();
    const collected = collect(queue);
    await Promise.resolve();
    queue.end();

    // Would hang forever if end() did not resolve pending waiters.
    expect(await collected).toEqual([]);
  });

  it("interleaves two independent producers", async () => {
    const queue = new AsyncQueue<string>();
    const collected = collect(queue);

    await Promise.resolve();
    queue.push("status");
    queue.push("log");
    await Promise.resolve();
    queue.push("log");
    queue.end();

    expect(await collected).toEqual(["status", "log", "log"]);
  });

  /*
   * The bound is what stops "push never awaits" from also meaning "the buffer is
   * unbounded". Without it a chatty container behind a stalled receiver grows this array
   * in the server process, and the only cap in the system lives in the browser — on the
   * far side of the socket that is not draining.
   */
  describe("when the consumer is not keeping up", () => {
    it("is unbounded by default, so existing callers are unaffected", () => {
      const queue = new AsyncQueue<number>();
      for (let i = 0; i < 5_000; i++) queue.push(i);
      expect(queue.dropped).toBe(0);
    });

    it("drops the oldest once full, keeping the tail", async () => {
      const queue = new AsyncQueue<number>(3);
      queue.push(1);
      queue.push(2);
      queue.push(3);
      queue.push(4);
      queue.push(5);
      queue.end();

      // The lines that say why a build failed are the ones that arrived last.
      expect(await collect(queue)).toEqual([3, 4, 5]);
    });

    it("counts what it dropped", () => {
      const queue = new AsyncQueue<number>(2);
      queue.push(1);
      queue.push(2);
      expect(queue.dropped).toBe(0);

      queue.push(3);
      queue.push(4);
      expect(queue.dropped).toBe(2);
    });

    it("does not count against the bound while a consumer is parked", async () => {
      // A waiting consumer is handed the item directly; nothing is buffered, so a
      // healthy reader never trips the ceiling however many lines pass through.
      const queue = new AsyncQueue<number>(1);
      const collected = collect(queue);

      await Promise.resolve();
      queue.push(1);
      await Promise.resolve();
      queue.push(2);
      await Promise.resolve();
      queue.end();

      expect(await collected).toEqual([1, 2]);
      expect(queue.dropped).toBe(0);
    });
  });
});
