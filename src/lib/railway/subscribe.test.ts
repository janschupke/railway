import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "graphql-ws";
import { streamLogs } from "./subscribe";
import type { LogLine } from "./types";

/**
 * The upstream socket, which had no test at all.
 *
 * It sat at 0% behind a global coverage threshold that could not see it — the number
 * read 94% while the one module carrying Railway's push stream was untested. It is also
 * the module security.md singles out, because a `ws` failure carries the resolved
 * upstream address in its message.
 *
 * `createLogClient` is not tested here: it is configuration for a real socket, and a
 * test that asserted its options back would pin the shape without proving anything.
 * `streamLogs` is where the behaviour is, and it takes the client injected.
 */

const line = (message: string): LogLine => ({
  timestamp: "2026-08-13T10:00:00Z",
  message,
});

/** A Client whose iterate() yields what the test hands it. */
function fakeClient(
  results: Array<Record<string, unknown>>,
  onReturn?: () => void,
): Client {
  return {
    iterate: () => {
      let index = 0;
      const iterator: AsyncIterableIterator<unknown> = {
        [Symbol.asyncIterator]: () => iterator,
        next: async () =>
          index < results.length
            ? { value: { data: results[index++] }, done: false }
            : { value: undefined, done: true },
        return: async () => {
          onReturn?.();
          index = results.length;
          return { value: undefined, done: true as const };
        },
        throw: async () => ({ value: undefined, done: true as const }),
      };
      return iterator;
    },
  } as unknown as Client;
}

const collect = async (gen: AsyncGenerator<LogLine>) => {
  const out: LogLine[] = [];
  for await (const item of gen) out.push(item);
  return out;
};

describe("streamLogs", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("yields the lines a push carries", async () => {
    const client = fakeClient([{ deploymentLogs: [line("one"), line("two")] }]);

    const lines = await collect(
      streamLogs(
        client,
        "query",
        "deploymentLogs",
        "dep_1",
        new AbortController().signal,
      ),
    );

    // Railway batches: one push, many lines. Flattening here is why the monitor never
    // has to know that.
    expect(lines.map((l) => l.message)).toEqual(["one", "two"]);
  });

  it("accepts a single object as well as an array", async () => {
    // The field is typed as either, and a shape that arrived un-batched used to be
    // iterated character by character if this were treated as a list unconditionally.
    const client = fakeClient([{ buildLogs: line("solo") }]);

    const lines = await collect(
      streamLogs(client, "query", "buildLogs", "dep_1", new AbortController().signal),
    );

    expect(lines.map((l) => l.message)).toEqual(["solo"]);
  });

  it("skips a push with nothing in the field", async () => {
    // Railway sends keep-alive-ish frames with a null payload; treating those as a line
    // would put empty rows in the pane.
    const client = fakeClient([
      { deploymentLogs: null },
      { deploymentLogs: [line("real")] },
      {},
    ]);

    const lines = await collect(
      streamLogs(
        client,
        "query",
        "deploymentLogs",
        "dep_1",
        new AbortController().signal,
      ),
    );

    expect(lines.map((l) => l.message)).toEqual(["real"]);
  });

  it("returns the upstream iterator when the caller aborts", async () => {
    /*
     * The property that matters for the slot cap: aborting has to reach the socket, not
     * merely stop this loop. A generator that returned without calling iterator.return
     * would leave the subscription — and its connection — open upstream.
     */
    const returned = vi.fn();
    const controller = new AbortController();
    const client = fakeClient([{ deploymentLogs: [line("one")] }], returned);

    const gen = streamLogs(
      client,
      "query",
      "deploymentLogs",
      "dep_1",
      controller.signal,
    );
    await gen.next();
    controller.abort();

    expect(returned).toHaveBeenCalledTimes(1);
    await gen.return(undefined);
  });

  it("stops yielding once aborted, even if the socket pushes again", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = fakeClient([{ deploymentLogs: [line("late")] }]);

    const lines = await collect(
      streamLogs(client, "query", "deploymentLogs", "dep_1", controller.signal),
    );

    expect(lines).toEqual([]);
  });

  it("removes its abort listener when the stream ends", async () => {
    // Every open log pane adds one. Left behind, they accumulate on a signal that lives
    // as long as the request does.
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const client = fakeClient([{ deploymentLogs: [line("one")] }]);

    await collect(
      streamLogs(client, "query", "deploymentLogs", "dep_1", controller.signal),
    );

    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});
