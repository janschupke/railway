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
});
