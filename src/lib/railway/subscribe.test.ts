import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client, ClientOptions } from "graphql-ws";
import { __resetEnv } from "@/env";
import { rawLogLines } from "@/test/log-capture";
import { railwayWsUrl } from "./client";
import { createLogClient, streamLogs } from "./subscribe";
import type { LogLine } from "./types";

/**
 * The upstream socket, which had no test at all.
 *
 * It sat at 0% behind a global coverage threshold that could not see it — the number
 * read 94% while the one module carrying Railway's push stream was untested. It is also
 * the module security.md singles out, because a `ws` failure carries the resolved
 * upstream address in its message.
 *
 * `createLogClient` used to be left out on the grounds that it is configuration for a
 * real socket, and that asserting its options back would pin the shape without proving
 * anything. Half of that holds: nothing below asserts `retryAttempts` back, because a
 * test that reads a literal out of the file it is testing is the file typed twice.
 *
 * The other half did not. Where the access token goes is behaviour, not shape — the
 * subclass has to reach `ws`'s third constructor argument for the header to exist at all,
 * and that is a thing code can stop doing. It left the credential path on the one module
 * whose transport puts a bearer on an upgrade request completely unexercised, and it is
 * the reason function coverage here read 33%.
 */

/** Records what `ws` was constructed with, so the header can be read off the real call. */
const sockets: Array<{ address: string | URL; options?: { headers?: unknown } }> = [];

vi.mock("ws", () => ({
  default: class {
    constructor(
      address: string | URL,
      _protocols?: string | string[],
      options?: { headers?: unknown },
    ) {
      sockets.push({ address, options });
    }
  },
}));

vi.mock("graphql-ws", async (importOriginal) => ({
  ...(await importOriginal<typeof import("graphql-ws")>()),
  createClient: vi.fn(() => ({}) as Client),
}));

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

const TOKEN = "rw_live_subscribe_canary_token";

/** The options `createLogClient` handed to graphql-ws on its most recent call. */
async function clientOptions(accessToken = TOKEN): Promise<ClientOptions> {
  const { createClient } = await import("graphql-ws");
  createLogClient(accessToken);
  const call = vi.mocked(createClient).mock.calls.at(-1);
  if (!call) throw new Error("createClient was not called");
  return call[0];
}

describe("createLogClient", () => {
  beforeEach(() => {
    sockets.length = 0;
    vi.clearAllMocks();
  });

  it("points at the endpoint env validated, not at a literal", async () => {
    /*
     * env.ts refuses a `ws://` RAILWAY_WS_URL that is not loopback, because the upgrade
     * request below carries a live access token. That refinement protects nothing if this
     * module reads the URL from somewhere else, so the assertion is that the two agree —
     * `railwayWsUrl()` is the accessor, and it is the only permitted source.
     *
     * Overridden to something that is *not* the default first. Asserting against the
     * ambient value proves nothing: RAILWAY_WS_URL defaults to Railway's own endpoint, so
     * a hardcoded literal of that string passes an equality check against the accessor it
     * replaced. Confirmed by mutation — inlining the default keeps this green until the
     * variable says otherwise, which is the whole point of it being a variable.
     */
    const previous = process.env.RAILWAY_WS_URL;
    process.env.RAILWAY_WS_URL = "wss://fixture.invalid/graphql/v2";
    __resetEnv();

    try {
      expect(railwayWsUrl()).toBe("wss://fixture.invalid/graphql/v2");
      expect((await clientOptions()).url).toBe("wss://fixture.invalid/graphql/v2");
    } finally {
      if (previous === undefined) delete process.env.RAILWAY_WS_URL;
      else process.env.RAILWAY_WS_URL = previous;
      __resetEnv();
    }
  });

  it("puts the bearer on the upgrade request as well as in connectionParams", async () => {
    /*
     * Both, because Railway's expectation is undocumented and the module says so. The
     * header is the half that only exists if `authedSocket` threads options into `ws`'s
     * third argument — a browser WebSocket has no such parameter, so this is the part a
     * refactor toward a portable socket would silently drop, leaving a subscription that
     * connects and is never authorized.
     */
    const options = await clientOptions();

    expect(options.connectionParams).toEqual({ Authorization: `Bearer ${TOKEN}` });

    const Impl = options.webSocketImpl as new (url: string) => unknown;
    new Impl("wss://example.invalid/graphql");

    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.options?.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
    });
  });

  it("retries every failure class, because reconnection policy is the route's", async () => {
    /*
     * Not a shape assertion: `shouldRetry` has a real alternative — classifying the error
     * and declining the ones that cannot succeed — and this module deliberately does not
     * take it. The SSE route owns when to give up, bounded by streamDurationMs, and a
     * second opinion down here would silently shorten a stream the route still wants.
     */
    const options = await clientOptions();

    expect(options.shouldRetry?.(new Error("not a transient failure"))).toBe(true);
  });

  it("writes no part of the token to stdout", async () => {
    /*
     * The canary this module was missing. security.md singles it out because a `ws`
     * failure message carries the resolved upstream address; the worse neighbour of that
     * is the bearer sitting one property away from it. Asserted over the raw written
     * bytes rather than parsed records, so a stray `console.*` would fail too.
     */
    await clientOptions();
    const Impl = (await clientOptions()).webSocketImpl as new (url: string) => unknown;
    new Impl("wss://example.invalid/graphql");

    expect(rawLogLines().join("\n")).not.toContain(TOKEN);
  });
});

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
