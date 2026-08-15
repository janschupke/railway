import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "@/env";
import { STREAM, WATCH } from "@/lib/constants";
import type { Container } from "@/lib/railway/types";

const session = {
  user: { id: "u_watch", name: "Ada", email: "ada@example.com" },
  accessToken: "token",
  refreshToken: "refresh",
  expiresAt: 9_999_999_999,
  scope: "openid project:admin",
};
const requireSession = vi.fn(async () => session);
vi.mock("@/lib/auth/server", () => ({
  requireSession: () => requireSession(),
  requireAccessToken: async () => (await requireSession()).accessToken,
}));

const getProjectContainers = vi.fn();
vi.mock("@/lib/railway/projects", () => ({
  getProjectContainers: (...args: unknown[]) => getProjectContainers(...args),
}));

const { GET: watch } = await import("./[projectId]/route");
const { __resetEnv } = await import("@/env");
const { RailwayApiError } = await import("@/lib/railway/errors");

const container = (over: Partial<Container> = {}): Container => ({
  serviceId: "svc_1",
  rawName: "spun-cache",
  displayName: "cache",
  image: "redis:7-alpine",
  repo: null,
  state: "running",
  rawStatus: "SUCCESS",
  deploymentId: "dep_1",
  createdAt: null,
  updatedAt: null,
  deployedAt: null,
  url: null,
  managed: true,
  ...over,
});

const POLL_MS = env().WATCH_POLL_MS;
const { MAX_PER_USER } = WATCH;

const request = (path: string) =>
  new NextRequest(new URL(path, "http://localhost:3000"));
const params = (projectId: string) => ({ params: Promise.resolve({ projectId }) });

/** Reads frames until the producer stops, with a ceiling so a wedge fails loudly. */
/**
 * Drains whole SSE frames out of a buffer, returning what is left of a partial one.
 *
 * The trailing element of the split is whatever followed the last `\n\n` — a frame that
 * has not finished arriving — so it goes back to the caller rather than being matched or
 * discarded.
 *
 * Both readers below used to clear their buffer outright after each read, and the failure
 * that caused is worse than losing the frame. `\w+` happily matches a truncated name, so a
 * read ending mid-`event: stale` recorded **`"st"`** and then threw away the remainder
 * that would have completed it — an assertion comparing an exact list saw `["ready", "st"]`
 * and reported a frame nobody sent.
 *
 * Nothing controls where a chunk boundary falls, so it depended on machine load: these
 * specs passed every time they ran alone or as a project, and produced one failure across
 * the full run under coverage. Found by reading the helper rather than by re-running it,
 * and confirmed by feeding this function a stream split at that byte.
 */
function drainFrames(buffer: string, frames: string[]): string {
  const parts = buffer.split("\n\n");
  const partial = parts.pop() ?? "";
  for (const chunk of parts) {
    const match = /^event: (\w+)/m.exec(chunk);
    if (match) frames.push(match[1]!);
  }
  return partial;
}

async function readFrames(response: Response, count: number): Promise<string[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: string[] = [];
  let buffer = "";

  while (frames.length < count) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer = drainFrames(buffer + decoder.decode(value, { stream: true }), frames);
  }
  await reader.cancel();
  return frames;
}

beforeEach(() => {
  vi.useFakeTimers();
  requireSession.mockReset().mockResolvedValue(session);
  getProjectContainers.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("GET /api/watch/[projectId]", () => {
  it("rejects an id it will not send to Railway", async () => {
    const response = await watch(
      request("/api/watch/..%2F..%2Fetc?environment=e1"),
      params("../../etc"),
    );

    expect(response.status).toBe(400);
    expect(getProjectContainers).not.toHaveBeenCalled();
  });

  it("rejects a missing environment rather than watching the wrong thing", async () => {
    const response = await watch(request("/api/watch/p1"), params("p1"));

    expect(response.status).toBe(400);
    expect(getProjectContainers).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated request", async () => {
    requireSession.mockImplementation(async () => {
      throw new Error("no session");
    });

    const response = await watch(request("/api/watch/p1?environment=e1"), params("p1"));

    expect(response.status).toBe(401);
  });

  it("announces a change only when the project actually changed", async () => {
    /*
     * A `changed` per tick would refresh a force-dynamic page every fifteen seconds
     * forever — two Railway round trips each — which is worse than not watching at all.
     */
    getProjectContainers
      .mockResolvedValueOnce({ containers: [container()] })
      .mockResolvedValueOnce({ containers: [container()] })
      .mockResolvedValue({ containers: [container({ state: "failed" })] });

    const response = await watch(request("/api/watch/p1?environment=e1"), params("p1"));
    const frames = readFrames(response, 2);
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);

    // ready, then nothing for the identical poll, then changed.
    expect(await frames).toEqual(["ready", "changed"]);
  });

  it("names a revoked authorization and stops, instead of burning quota on it", async () => {
    /*
     * An access token *expiring* is handled by the transport's duration ceiling — the
     * connection closes, the browser reconnects and requireSession mints a fresh one.
     * Reaching this branch means the grant was revoked, and retrying that forever is
     * the quota-burning mistake it exists to prevent.
     */
    getProjectContainers
      .mockResolvedValueOnce({ containers: [] })
      .mockRejectedValue(new RailwayApiError("Not Authorized", { kind: "auth" }));

    const response = await watch(request("/api/watch/p1?environment=e1"), params("p1"));
    const frames = readFrames(response, 2);
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);

    expect(await frames).toEqual(["ready", "error"]);
    // Stopped, rather than polling a grant that will keep saying no.
    const callsAtFailure = getProjectContainers.mock.calls.length;
    await vi.advanceTimersByTimeAsync(POLL_MS * 4);
    expect(getProjectContainers).toHaveBeenCalledTimes(callsAtFailure);
  });

  it("stops with the token it captured rather than at the transport ceiling", async () => {
    /*
     * The access token is read once, at open, and nothing renews it for the life of the
     * response — the proxy refreshes on navigations, and a held stream is not one. On the
     * transport's own fifteen-minute ceiling this loop therefore kept polling Railway for
     * up to ten minutes past the point the credential died, because requireSession
     * guarantees only the five-minute refresh skew behind it.
     */
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const lifetimeMs = 400_000;
    requireSession.mockResolvedValue({
      ...session,
      expiresAt: Math.floor(Date.now() / 1000) + lifetimeMs / 1000,
    });
    getProjectContainers.mockResolvedValue({ containers: [] });

    // No reader, for the reason the backoff case below states: the producer runs on
    // construction, and a reader that cancelled would end the stream on its own terms.
    await watch(request("/api/watch/p1?environment=e1"), params("p1"));

    await vi.advanceTimersByTimeAsync(lifetimeMs);
    const atExpiry = getProjectContainers.mock.calls.length;
    expect(atExpiry).toBeGreaterThan(1);

    // On to where the ceiling alone would have ended it. Nothing more was spent, and the
    // browser's redial is what re-authenticates.
    await vi.advanceTimersByTimeAsync(STREAM.MAX_DURATION_MS - lifetimeMs);
    expect(getProjectContainers).toHaveBeenCalledTimes(atExpiry);
    random.mockRestore();
  });

  it("backs off a transient failure instead of hammering Railway", async () => {
    /*
     * A Railway outage must not turn every open tab into a full-rate poll for the length
     * of the outage — that is quota spent learning nothing.
     *
     * Jitter is pinned rather than tolerated: the assertion is about the backoff curve,
     * and a test that sometimes measures the spread instead is a test nobody trusts.
     */
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    getProjectContainers.mockRejectedValue(new Error("network"));

    // No reader: `new ReadableStream({ start })` runs the producer on construction, so
    // the poll loop runs whether or not anyone is listening.
    const response = await watch(request("/api/watch/p1?environment=e1"), params("p1"));

    await vi.advanceTimersByTimeAsync(POLL_MS * 40);

    // A fixed interval would have made forty attempts across that window; doubling to
    // the two-minute ceiling makes single digits.
    expect(getProjectContainers.mock.calls.length).toBeLessThan(10);
    await response.body!.cancel();
    random.mockRestore();
  });

  it("holds a budget separate from the log streams", async () => {
    // Namespaced into the same map: a tab full of open log panes must not starve the
    // watcher, and a watcher must not consume a log-pane slot.
    //
    // Its own user, so the count cannot inherit a slot another case in this file failed
    // to release — the assertion is about the cap, not about test ordering.
    requireSession.mockResolvedValue({
      ...session,
      user: { ...session.user, id: "u_budget" },
    });
    getProjectContainers.mockResolvedValue({ containers: [] });

    const open: Response[] = [];
    for (let i = 0; i < MAX_PER_USER; i++) {
      open.push(await watch(request("/api/watch/p1?environment=e1"), params("p1")));
    }
    expect(open.every((response) => response.status === 200)).toBe(true);

    const refused = await watch(request("/api/watch/p1?environment=e1"), params("p1"));
    expect(refused.status).toBe(429);

    for (const response of open) await response.body!.cancel();
  });

  /*
   * The staleness nudge.
   *
   * Metrics are read on the render rather than polled, so on a project where nothing
   * changes the readouts would sit at whatever they were when the page loaded. `stale` is
   * the second reason to send an empty frame — and most of the cases below are a class of
   * request this must NOT spend.
   */
  describe("the staleness nudge", () => {
    /** Ticks needed to cross a staleness window, given the watch interval. */
    const ticksToStale = Math.ceil(env().METRICS_POLL_MS / POLL_MS) + 1;

    /*
     * Collects frames until told to stop, rather than until a count is reached.
     *
     * readFrames above waits for N frames and would hang forever here: half these cases
     * assert that a frame is NOT sent, and "nothing arrived" is indistinguishable from
     * "still waiting" to a reader counting up to a target.
     */
    const collectFrames = (response: Response) => {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      const frames: string[] = [];

      const drained = (async () => {
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer = drainFrames(
            buffer + decoder.decode(value, { stream: true }),
            frames,
          );
        }
      })();

      return {
        frames,
        stop: async () => {
          /*
           * Settle before cancelling, or the last frame is a coin toss.
           *
           * `reader.cancel()` discards whatever is queued and not yet pulled, and the
           * frame this describe block is usually asserting on is enqueued by the final
           * timer callback — one microtask turn ahead of the read that would collect it.
           * Cancelling straight away therefore dropped it whenever the loop happened to
           * be a turn behind, which is a property of how busy the machine is: these cases
           * passed on their own and on a plain `vitest run`, and failed under coverage,
           * where the instrumentation changes the scheduling.
           *
           * Flushing microtasks until the count stops moving is deterministic under fake
           * timers and is not a wait: no clock advances here, and a stream with nothing
           * queued settles on the first pass. It is also what the negative cases in this
           * block need — "no frame was sent" is only true once everything that was going
           * to arrive has.
           */
          let settled = 0;
          for (let turn = 0; turn < 50 && settled < 3; turn++) {
            const before = frames.length;
            await Promise.resolve();
            settled = frames.length === before ? settled + 1 : 0;
          }
          await reader.cancel();
          await drained;
        },
      };
    };

    const withMetricsPoll = async (value: string, body: () => Promise<void>) => {
      const previous = process.env.METRICS_POLL_MS;
      process.env.METRICS_POLL_MS = value;
      __resetEnv();
      try {
        await body();
      } finally {
        if (previous === undefined) delete process.env.METRICS_POLL_MS;
        else process.env.METRICS_POLL_MS = previous;
        __resetEnv();
      }
    };

    it("nudges a tab whose readouts have gone stale on an unchanged project", async () => {
      getProjectContainers.mockResolvedValue({ containers: [container()] });

      const response = await watch(
        request("/api/watch/p1?environment=e1"),
        params("p1"),
      );
      const { frames, stop } = collectFrames(response);
      await vi.advanceTimersByTimeAsync(POLL_MS * ticksToStale);
      await stop();

      // Never `changed` — the container set did not move, and saying it did would be this
      // endpoint carrying a claim that is not true.
      expect(frames).toEqual(["ready", "stale"]);
    });

    it("stays silent while nothing is running, however long the tab is open", async () => {
      /*
       * The reason this clock is on the server rather than in the hook. A stopped
       * environment's readouts are all em dashes and cannot go stale, so a nudge would
       * spend four Railway requests to re-render the same nothing. A setInterval in the
       * browser does not know that; this side does.
       */
      getProjectContainers.mockResolvedValue({
        containers: [container({ state: "failed" })],
      });

      const response = await watch(
        request("/api/watch/p1?environment=e1"),
        params("p1"),
      );
      const { frames, stop } = collectFrames(response);
      await vi.advanceTimersByTimeAsync(POLL_MS * ticksToStale * 2);
      await stop();

      expect(frames).toEqual(["ready"]);
    });

    it("sends nothing at all when metrics are switched off", async () => {
      // METRICS_POLL_MS=0 is how an account whose quota is committed to log streams opts
      // out. It has to cost exactly zero, not merely less.
      await withMetricsPoll("0", async () => {
        getProjectContainers.mockResolvedValue({ containers: [container()] });

        const response = await watch(
          request("/api/watch/p1?environment=e1"),
          params("p1"),
        );
        const { frames, stop } = collectFrames(response);
        await vi.advanceTimersByTimeAsync(POLL_MS * ticksToStale * 2);
        await stop();

        expect(frames).toEqual(["ready"]);
      });
    });

    it("sends one frame, not two, when a change lands on the tick staleness is due", async () => {
      /*
       * A `changed` causes the refresh a `stale` would have asked for, so emitting both
       * would be two events for one render — and through the tab-shared throttle the
       * second would be silently dropped, which looks identical to it having worked.
       *
       * The change is timed to land on the very tick the staleness window expires, which
       * is the only tick where both branches are live at once.
       */
      let polls = 0;
      getProjectContainers.mockImplementation(async () => ({
        containers: [
          container(polls++ >= ticksToStale - 1 ? { image: "redis:8" } : {}),
        ],
      }));

      const response = await watch(
        request("/api/watch/p1?environment=e1"),
        params("p1"),
      );
      const { frames, stop } = collectFrames(response);
      await vi.advanceTimersByTimeAsync(POLL_MS * ticksToStale);
      await stop();

      expect(frames).toEqual(["ready", "changed"]);
      expect(frames).not.toContain("stale");
    });
  });
});
