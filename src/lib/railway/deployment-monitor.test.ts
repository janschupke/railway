import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STREAM } from "@/lib/constants";
import {
  monitorDeployment,
  type MonitorDeps,
  type MonitorEvent,
} from "./deployment-monitor";
import { RailwayApiError } from "./errors";
import type { LogLine } from "./types";

const line = (message: string): LogLine => ({
  timestamp: "2026-08-12T10:00:00Z",
  message,
});

/** Nothing here touches the network or a socket — the monitor takes its deps injected. */
function deps(overrides: Partial<MonitorDeps> = {}): MonitorDeps {
  return {
    getLogs: vi.fn(async () => []),
    getDeployment: vi.fn(async () => ({
      id: "dep_1",
      status: "SUCCESS",
      updatedAt: null,
    })),
    subscribeLogs: async function* () {},
    ...overrides,
  } as MonitorDeps;
}

async function drain(
  gen: AsyncGenerator<MonitorEvent>,
  advance: () => Promise<void>,
): Promise<MonitorEvent[]> {
  const events: MonitorEvent[] = [];
  const consume = (async () => {
    for await (const event of gen) events.push(event);
  })();
  await advance();
  await consume;
  return events;
}

describe("monitorDeployment", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const params = () => ({
    accessToken: "token",
    deploymentId: "dep_1",
    phase: "deploy" as const,
    signal: new AbortController().signal,
  });

  it("emits backfilled logs, then ready, then status, then done", async () => {
    const events = await drain(
      monitorDeployment(
        params(),
        deps({ getLogs: vi.fn(async () => [line("older")]) }),
      ),
      async () => {
        await vi.advanceTimersByTimeAsync(STREAM.DRAIN_MS + 100);
      },
    );

    expect(events.map((e) => e.type)).toEqual(["log", "ready", "status", "done"]);
    expect(events[0]).toMatchObject({ type: "log", line: { message: "older" } });
    expect(events[1]).toMatchObject({ backfilled: 1 });
    expect(events[2]).toMatchObject({ state: "running", rawStatus: "SUCCESS" });
  });

  it("waits DRAIN_MS after a terminal status so trailing logs still land", async () => {
    // A build's last lines routinely arrive after the status flips to SUCCESS.
    let emit: ((l: LogLine) => void) | undefined;
    const subscribeLogs = async function* () {
      const queue: LogLine[] = [];
      let resolve: (() => void) | undefined;
      emit = (l) => {
        queue.push(l);
        resolve?.();
      };
      for (;;) {
        if (queue.length) {
          yield queue.shift()!;
          continue;
        }
        await new Promise<void>((r) => {
          resolve = r;
        });
      }
    };

    const events = await drain(
      monitorDeployment(params(), deps({ subscribeLogs })),
      async () => {
        await vi.advanceTimersByTimeAsync(10);
        emit?.(line("trailing"));
        await vi.advanceTimersByTimeAsync(STREAM.DRAIN_MS + 100);
      },
    );

    const types = events.map((e) => e.type);
    expect(types).toContain("log");
    expect(types.indexOf("log")).toBeLessThan(types.indexOf("done"));
    expect(types.at(-1)).toBe("done");
  });

  it("still streams when the backfill query fails", async () => {
    // Missing history must not prevent the live stream from working.
    const events = await drain(
      monitorDeployment(
        params(),
        deps({
          getLogs: vi.fn(async () => {
            throw new RailwayApiError("nope", { kind: "graphql" });
          }),
        }),
      ),
      async () => {
        await vi.advanceTimersByTimeAsync(STREAM.DRAIN_MS + 100);
      },
    );

    expect(events[0]).toMatchObject({
      type: "warning",
      // A descriptor, not a sentence: the monitor has no translator of its own — and
      // not Railway's own text either, which goes to the log against this incident id.
      message: { key: "errors.api.graphqlUnexpected" },
    });
    expect(JSON.stringify(events[0])).not.toContain("nope");
    expect(events.map((e) => e.type)).toContain("ready");
    expect(events.at(-1)?.type).toBe("done");
  });

  it("gives up on a deployment that never appears, instead of polling for 15 minutes", async () => {
    /*
     * An identifier that resolves to nothing used to be a silent `return`, so the poll
     * interval and the upstream socket stayed alive until the duration ceiling. That
     * made an arbitrary id the cheapest way to hold this server's resources.
     */
    const events = await drain(
      monitorDeployment(params(), deps({ getDeployment: vi.fn(async () => null) })),
      async () => {
        await vi.advanceTimersByTimeAsync(
          STREAM.STATUS_POLL_MS * (STREAM.MISSING_POLLS_BEFORE_STOP + 1),
        );
      },
    );

    expect(events.at(-1)).toMatchObject({
      type: "error",
      message: { key: "errors.deploymentNotFound" },
    });
    // drain() only resolves once the generator completes, so reaching this line is
    // itself the proof that stop() cleared the interval.
  });

  it("gives up on a status it cannot map, instead of polling for 15 minutes", async () => {
    /*
     * Railway can add a DeploymentStatus member at any time, and an unmapped one is
     * neither terminal nor transitioning — so there was no condition under which this
     * stream ever ended. It polled every 2.5s and held an upstream socket for the full
     * ceiling, then closed with no frame at all, which the browser answers by redialling:
     * a silent fifteen-minute cycle, repeating.
     *
     * `unknown` is still not treated as settled — closing on a status we do not
     * understand would be a guess. It is bounded by poll count instead.
     */
    const events = await drain(
      monitorDeployment(
        params(),
        deps({
          getDeployment: vi.fn(async () => ({
            id: "dep_1",
            status: "HIBERNATING_PENDING_REVIEW",
            updatedAt: null,
          })),
        }),
      ),
      async () => {
        await vi.advanceTimersByTimeAsync(
          STREAM.STATUS_POLL_MS * (STREAM.UNSETTLED_POLLS_BEFORE_STOP + 1),
        );
      },
    );

    expect(events.at(-1)).toMatchObject({ type: "done", state: "unknown" });
    const polls = events.filter((e) => e.type === "status").length;
    expect(polls).toBeLessThanOrEqual(STREAM.UNSETTLED_POLLS_BEFORE_STOP);
  });

  it("tolerates the eventual consistency of a just-created deployment", async () => {
    // The first poll fires milliseconds after the deploy mutation returns; a null there
    // is normal, and treating it as fatal would break every real spin-up.
    let calls = 0;
    const events = await drain(
      monitorDeployment(
        params(),
        deps({
          getDeployment: vi.fn(async () => {
            calls += 1;
            return calls <= 2
              ? null
              : { id: "dep_1", status: "SUCCESS", updatedAt: null };
          }),
        }),
      ),
      async () => {
        await vi.advanceTimersByTimeAsync(STREAM.STATUS_POLL_MS * 3 + STREAM.DRAIN_MS);
      },
    );

    expect(events.map((e) => e.type)).not.toContain("error");
    expect(events.at(-1)?.type).toBe("done");
  });

  it("ends the stream on an auth failure instead of polling forever", async () => {
    const events = await drain(
      monitorDeployment(
        params(),
        deps({
          getDeployment: vi.fn(async () => {
            throw new RailwayApiError("gone", { kind: "auth" });
          }),
        }),
      ),
      async () => {
        await vi.advanceTimersByTimeAsync(100);
      },
    );

    expect(events.at(-1)?.type).toBe("error");
  });

  it("keeps polling through a transient failure", async () => {
    const getDeployment = vi
      .fn()
      .mockRejectedValueOnce(new RailwayApiError("blip", { kind: "server" }))
      .mockResolvedValue({ id: "dep_1", status: "SUCCESS", updatedAt: null });

    const events = await drain(
      monitorDeployment(params(), deps({ getDeployment })),
      async () => {
        await vi.advanceTimersByTimeAsync(
          STREAM.STATUS_POLL_MS + STREAM.DRAIN_MS + 100,
        );
      },
    );

    expect(getDeployment.mock.calls.length).toBeGreaterThan(1);
    expect(events.some((e) => e.type === "status")).toBe(true);
  });

  it("stops when the caller aborts", async () => {
    const controller = new AbortController();
    const gen = monitorDeployment(
      { ...params(), signal: controller.signal },
      deps({
        getDeployment: vi.fn(async () => ({
          id: "dep_1",
          status: "BUILDING",
          updatedAt: null,
        })),
      }),
    );

    const events = await drain(gen, async () => {
      await vi.advanceTimersByTimeAsync(10);
      controller.abort();
      await vi.advanceTimersByTimeAsync(10);
    });

    // A non-terminal deployment would otherwise poll to the stream ceiling.
    expect(events.some((e) => e.type === "done")).toBe(false);
    expect(events.some((e) => e.type === "status")).toBe(true);
  });
});
