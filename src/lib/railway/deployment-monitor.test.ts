import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STREAM } from "@/lib/constants";
import { sleep } from "@/lib/utils";
import { logRecords } from "@/test/log-capture";
import {
  monitorDeployment,
  type MonitorDeps,
  type MonitorEvent,
} from "./deployment-monitor";
import { RailwayApiError } from "./errors";
import type { LogLine, LogPhase } from "./types";

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
    /*
     * Present in the default rather than only where it is asserted. Left off, the terminal
     * branch calls undefined, the best-effort catch swallows the TypeError, and every
     * failure case in this file passes while measuring nothing.
     */
    getDeploymentFailure: vi.fn(async () => null),
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
    // itself the proof that stop() ended the poll loop.
    //
    // Stated in the base interval on purpose: a null carries no state, so this is the one
    // path the escalation ladder never stretches.
  });

  it("gives up on a status it cannot map, instead of polling for 15 minutes", async () => {
    /*
     * Railway can add a DeploymentStatus member at any time, and an unmapped one is
     * neither terminal nor transitioning — so there was no condition under which this
     * stream ever ended. It polled and held an upstream socket for the full ceiling, then
     * closed with no frame at all, which the browser answers by redialling: a silent
     * fifteen-minute cycle, repeating.
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
        // A state that never changes escalates, so the window is stated in the ceiling:
        // no two polls can be further apart than that, however the ladder is tuned.
        await vi.advanceTimersByTimeAsync(
          STREAM.MAX_POLL_MS * (STREAM.UNSETTLED_POLLS_BEFORE_STOP + 1),
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
        // The first failure doubles the interval, so the retry that recovers lands at
        // twice the base rather than at it.
        await vi.advanceTimersByTimeAsync(
          STREAM.STATUS_POLL_MS * 2 + STREAM.DRAIN_MS + 100,
        );
      },
    );

    expect(getDeployment.mock.calls.length).toBeGreaterThan(1);
    expect(events.some((e) => e.type === "status")).toBe(true);
  });

  it("never has two polls in flight, however slow Railway is", async () => {
    /*
     * setInterval fired on wall-clock time whether or not the poll it started last time
     * had returned, so a Railway that took longer than the interval received overlapping
     * requests exactly when it wanted fewer — and missingPolls, unsettledPolls and
     * consecutiveFailures were counters two calls could interleave on.
     */
    let inFlight = 0;
    let overlapped = false;
    const getDeployment = vi.fn(async () => {
      inFlight += 1;
      overlapped ||= inFlight > 1;
      // Deliberately longer than the interval that would have started the next one.
      await sleep(STREAM.STATUS_POLL_MS * 2);
      inFlight -= 1;
      return { id: "dep_1", status: "BUILDING", updatedAt: null };
    });

    const controller = new AbortController();
    await drain(
      monitorDeployment(
        { ...params(), signal: controller.signal },
        deps({ getDeployment }),
      ),
      async () => {
        await vi.advanceTimersByTimeAsync(STREAM.STATUS_POLL_MS * 10);
        controller.abort();
      },
    );

    expect(overlapped).toBe(false);
    expect(getDeployment.mock.calls.length).toBeGreaterThan(1);
  });

  it("stops polling before it awaits the failure fallback", async () => {
    /*
     * The case a `settling` flag used to patch: the terminal branch awaits, and under a
     * fixed interval further polls fired into that await and re-entered the same branch,
     * fetching and emitting the same fallback twice. Serial polls retire the flag.
     */
    const getLogs = vi.fn(async (_token: string, _id: string, kind: LogPhase) => {
      if (kind === "build") await sleep(STREAM.STATUS_POLL_MS * 3);
      return [];
    });
    const getDeployment = vi.fn(async () => ({
      id: "dep_1",
      status: "FAILED",
      updatedAt: null,
    }));

    const events = await drain(
      monitorDeployment(params(), deps({ getLogs, getDeployment })),
      async () => {
        await vi.advanceTimersByTimeAsync(
          STREAM.STATUS_POLL_MS * 3 + STREAM.DRAIN_MS + 100,
        );
      },
    );

    expect(getDeployment).toHaveBeenCalledTimes(1);
    expect(getLogs.mock.calls.map((c) => c[2])).toEqual(["deploy", "build"]);
    expect(events.at(-1)).toMatchObject({ type: "done", state: "failed" });
  });

  describe("when a deployment fails", () => {
    const failed = () =>
      vi.fn(async () => ({ id: "dep_1", status: "FAILED", updatedAt: null }));

    const runToDone = async (overrides: Partial<MonitorDeps>) =>
      drain(
        monitorDeployment(params(), deps({ getDeployment: failed(), ...overrides })),
        async () => {
          await vi.advanceTimersByTimeAsync(STREAM.DRAIN_MS + 100);
        },
      );

    it("says which step failed and what Railway said, before it says done", async () => {
      const events = await runToDone({
        getDeploymentFailure: vi.fn(async () => ({
          step: "BUILD_IMAGE",
          reason: "manifest for redis:nope not found",
        })),
      });

      expect(events).toContainEqual({
        type: "failure",
        deploymentId: "dep_1",
        step: "BUILD_IMAGE",
        reason: "manifest for redis:nope not found",
      });
      // Pushed before the drain window, or AsyncQueue would drop it after stop().
      expect(events.at(-1)).toMatchObject({ type: "done", state: "failed" });
    });

    it("asks even when the log phase already produced output", async () => {
      /*
       * The deliberate difference from the log fallback above, which is empty-only. The
       * commonest real failure prints two hundred plausible build lines and then fails on
       * HEALTHCHECK: the pane is full and the row still says nothing but "Failed", so a
       * `linesEmitted` gate here would hide this in exactly the case it exists for.
       */
      const getDeploymentFailure = vi.fn(async () => ({
        step: "HEALTHCHECK",
        reason: "no response on :8080",
      }));

      const events = await runToDone({
        getLogs: vi.fn(async () => [line("step 1/4 : FROM node")]),
        getDeploymentFailure,
      });

      expect(getDeploymentFailure).toHaveBeenCalledTimes(1);
      expect(events).toContainEqual(
        expect.objectContaining({ type: "failure", step: "HEALTHCHECK" }),
      );
    });

    it("does not ask about a deployment that succeeded", async () => {
      const getDeploymentFailure = vi.fn(async () => null);

      await drain(
        monitorDeployment(params(), deps({ getDeploymentFailure })),
        async () => {
          await vi.advanceTimersByTimeAsync(STREAM.DRAIN_MS + 100);
        },
      );

      expect(getDeploymentFailure).not.toHaveBeenCalled();
    });

    it("asks exactly once, however long the answer takes", async () => {
      // Serial polling is what retires the guard a `settling` flag used to provide; this
      // is the assertion that it still holds when the answer outlives a poll interval.
      const getDeploymentFailure = vi.fn(async () => {
        await sleep(STREAM.STATUS_POLL_MS * 3);
        return { step: "BUILD_IMAGE", reason: "slow to answer" };
      });

      const events = await drain(
        monitorDeployment(
          params(),
          deps({ getDeployment: failed(), getDeploymentFailure }),
        ),
        async () => {
          await vi.advanceTimersByTimeAsync(
            STREAM.STATUS_POLL_MS * 3 + STREAM.DRAIN_MS + 100,
          );
        },
      );

      expect(getDeploymentFailure).toHaveBeenCalledTimes(1);
      expect(events.filter((e) => e.type === "failure")).toHaveLength(1);
    });

    it("says nothing extra when Railway has nothing to add", async () => {
      const events = await runToDone({ getDeploymentFailure: vi.fn(async () => null) });

      expect(events.some((e) => e.type === "failure")).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: "done", state: "failed" });
    });

    it("still finishes, and stays quiet, when the reason fetch fails", async () => {
      /*
       * Silent by design: the user is already reading one failure, and a banner saying the
       * app could not explain it is worse than the sentence the row falls back to. The
       * trace is a debug record, not a second thing on screen.
       */
      const events = await runToDone({
        getDeploymentFailure: vi.fn(async () => {
          throw new RailwayApiError("Not Authorized", { kind: "auth" });
        }),
      });

      expect(events.some((e) => e.type === "warning" || e.type === "error")).toBe(
        false,
      );
      expect(events.at(-1)).toMatchObject({ type: "done", state: "failed" });
      expect(logRecords().map((r) => r.msg)).toContain(
        "railway.deployment.failure_reason_failed",
      );
    });
  });

  it("stretches the interval while a deployment sits in one state", async () => {
    // Four concurrent streams at a flat 2.5s were 1440 requests an hour against Hobby's
    // 1000. The output of a long build arrives over the log subscription regardless; the
    // poll is only there to notice the state change at the end of it.
    const at: number[] = [];
    const controller = new AbortController();

    await drain(
      monitorDeployment(
        { ...params(), signal: controller.signal },
        deps({
          getDeployment: vi.fn(async () => {
            at.push(Date.now());
            return { id: "dep_1", status: "BUILDING", updatedAt: null };
          }),
        }),
      ),
      async () => {
        await vi.advanceTimersByTimeAsync(STREAM.MAX_POLL_MS * 12);
        controller.abort();
      },
    );

    const base = STREAM.STATUS_POLL_MS;
    const rung = STREAM.POLLS_BEFORE_ESCALATION;
    const gaps = at.slice(1).map((t, i) => t - at[i]!);

    expect(gaps.slice(0, rung * 3)).toEqual([
      ...Array<number>(rung).fill(base),
      ...Array<number>(rung).fill(base * 2),
      ...Array<number>(rung).fill(base * 4),
    ]);
    // base * 8 would be 20s; the ceiling is the point.
    expect(Math.max(...gaps)).toBe(STREAM.MAX_POLL_MS);
  });

  it("returns to the base interval when the deployment actually moves", async () => {
    const at: number[] = [];
    let calls = 0;
    const controller = new AbortController();

    await drain(
      monitorDeployment(
        { ...params(), signal: controller.signal },
        deps({
          getDeployment: vi.fn(async () => {
            at.push(Date.now());
            calls += 1;
            // Long enough in one state to climb a rung, then a real transition.
            const status =
              calls <= STREAM.POLLS_BEFORE_ESCALATION + 1 ? "BUILDING" : "DEPLOYING";
            return { id: "dep_1", status, updatedAt: null };
          }),
        }),
      ),
      async () => {
        await vi.advanceTimersByTimeAsync(STREAM.MAX_POLL_MS * 4);
        controller.abort();
      },
    );

    const gaps = at.slice(1).map((t, i) => t - at[i]!);
    const rung = STREAM.POLLS_BEFORE_ESCALATION;
    expect(gaps[rung]).toBe(STREAM.STATUS_POLL_MS * 2);
    expect(gaps[rung + 1]).toBe(STREAM.STATUS_POLL_MS);
  });

  it("backs off a failing poll instead of retrying at the base interval", async () => {
    /*
     * Each poll is itself worth up to NETWORK.MAX_ATTEMPTS requests inside the client, so
     * a flat cadence through a 429 storm was this app's largest single source of load at
     * exactly the moment Railway was asking for less of it.
     */
    const getDeployment = vi.fn(async () => {
      throw new RailwayApiError("blip", { kind: "server" });
    });
    const controller = new AbortController();

    await drain(
      monitorDeployment(
        { ...params(), signal: controller.signal },
        deps({ getDeployment }),
      ),
      async () => {
        await vi.advanceTimersByTimeAsync(0);
        expect(getDeployment).toHaveBeenCalledTimes(1);

        // A whole base interval passes and nothing is sent: the first failure doubled it.
        await vi.advanceTimersByTimeAsync(STREAM.STATUS_POLL_MS);
        expect(getDeployment).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(STREAM.STATUS_POLL_MS);
        expect(getDeployment).toHaveBeenCalledTimes(2);

        // 2.5s, 5s, 10s, 20s, 40s, then the minute ceiling: single figures where the flat
        // interval spent 360 polls of up to three requests each.
        await vi.advanceTimersByTimeAsync(STREAM.MAX_DURATION_MS);
        expect(getDeployment.mock.calls.length).toBeLessThan(25);
        controller.abort();
      },
    );

    const failed = logRecords().filter(
      (r) => r.msg === "railway.deployment.poll_failed",
    );
    expect(failed.filter((r) => r.level === "warn")).toHaveLength(1);
    expect(failed[0]).toMatchObject({ backoff_ms: STREAM.STATUS_POLL_MS * 2 });
  });

  it("waits out Railway's own Retry-After rather than guessing at one", async () => {
    // The client has already waited this out once per attempt and given up; polling again
    // before the window closes spends another MAX_ATTEMPTS to be told the same thing.
    const retryAfterSeconds = 30;
    const getDeployment = vi.fn(async () => {
      throw new RailwayApiError("slow down", {
        kind: "rate_limit",
        status: 429,
        retryAfterSeconds,
      });
    });
    const controller = new AbortController();

    await drain(
      monitorDeployment(
        { ...params(), signal: controller.signal },
        deps({ getDeployment }),
      ),
      async () => {
        // A plain transient failure would have retried twice inside this window.
        await vi.advanceTimersByTimeAsync(STREAM.STATUS_POLL_MS * 4);
        expect(getDeployment).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(retryAfterSeconds * 1_000);
        expect(getDeployment).toHaveBeenCalledTimes(2);
        controller.abort();
      },
    );
  });

  it("falls back to doubling for a 429 that named no window", async () => {
    // Railway does not always send Retry-After, and an absent header is not a licence to
    // keep the base cadence against a quota that has just been refused.
    const getDeployment = vi.fn(async () => {
      throw new RailwayApiError("slow down", { kind: "rate_limit", status: 429 });
    });
    const controller = new AbortController();

    await drain(
      monitorDeployment(
        { ...params(), signal: controller.signal },
        deps({ getDeployment }),
      ),
      async () => {
        await vi.advanceTimersByTimeAsync(STREAM.STATUS_POLL_MS);
        expect(getDeployment).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(STREAM.STATUS_POLL_MS);
        expect(getDeployment).toHaveBeenCalledTimes(2);
        controller.abort();
      },
    );
  });

  describe("when a failure produced no output", () => {
    const failed = () =>
      vi.fn(async () => ({ id: "dep_1", status: "FAILED", updatedAt: null }));

    it("reads the other phase rather than reporting nothing at all", async () => {
      /*
       * The row picks its phase from a status as old as the page, and a failed deployment
       * is sent to deploy logs — so a build-phase failure on a container that was already
       * failed when the page loaded asked Railway for the half of the output that is
       * empty, and the pane said "No log output for this deployment."
       */
      const getLogs = vi.fn(async (_token, _id, kind: "build" | "deploy") =>
        kind === "build" ? [line("pull failed")] : [],
      );

      const events = await drain(
        monitorDeployment(params(), deps({ getLogs, getDeployment: failed() })),
        async () => {
          await vi.advanceTimersByTimeAsync(STREAM.DRAIN_MS + 100);
        },
      );

      expect(getLogs.mock.calls.map((c) => c[2])).toEqual(["deploy", "build"]);
      const types = events.map((e) => e.type);
      expect(types.indexOf("log")).toBeLessThan(types.indexOf("done"));
      expect(events.find((e) => e.type === "log")).toMatchObject({
        line: { message: "pull failed" },
      });
      expect(events.at(-1)).toMatchObject({ type: "done", state: "failed" });
    });

    it("does not go looking when the subscribed phase already said something", async () => {
      const getLogs = vi.fn(async () => [line("output")]);

      await drain(
        monitorDeployment(params(), deps({ getLogs, getDeployment: failed() })),
        async () => {
          await vi.advanceTimersByTimeAsync(STREAM.DRAIN_MS + 100);
        },
      );

      expect(getLogs).toHaveBeenCalledTimes(1);
    });

    it("does not go looking for a deployment that simply succeeded quietly", async () => {
      /*
       * A successful deployment with no output is normal and common — a database service
       * that logs nothing on boot is one — and fetching the other phase for every quiet
       * success would double the query cost of the commonest case to answer a question
       * nobody asked.
       */
      const getLogs = vi.fn(async () => []);

      await drain(monitorDeployment(params(), deps({ getLogs })), async () => {
        await vi.advanceTimersByTimeAsync(STREAM.DRAIN_MS + 100);
      });

      expect(getLogs).toHaveBeenCalledTimes(1);
    });

    it("still finishes when the fallback fetch fails too", async () => {
      // A failure to explain the failure is not worth a second banner over the first, and
      // certainly not worth a stream that never ends.
      const getLogs = vi
        .fn()
        .mockResolvedValueOnce([])
        .mockRejectedValue(new RailwayApiError("nope", { kind: "server" }));

      const events = await drain(
        monitorDeployment(params(), deps({ getLogs, getDeployment: failed() })),
        async () => {
          await vi.advanceTimersByTimeAsync(STREAM.DRAIN_MS + 100);
        },
      );

      expect(events.map((e) => e.type)).not.toContain("warning");
      expect(events.at(-1)).toMatchObject({ type: "done", state: "failed" });
    });
  });

  it("says so once when a chatty container outruns the reader", async () => {
    /*
     * Driven by hand rather than through drain(), which consumes as fast as the producer
     * emits and so never buffers anything. The defect only exists when the reader is
     * behind: the queue is what absorbs that, and until it was bounded it absorbed
     * without limit in the server process.
     */
    const burst = STREAM.MAX_QUEUED_EVENTS + 50;
    const controller = new AbortController();
    const gen = monitorDeployment(
      { ...params(), signal: controller.signal },
      deps({
        getDeployment: vi.fn(async () => ({
          id: "dep_1",
          status: "BUILDING",
          updatedAt: null,
        })),
        subscribeLogs: async function* () {
          for (let i = 0; i < burst; i++) yield line(`line ${i}`);
        },
      }),
    );

    // Start the body, then stop pulling so the producer runs ahead of the consumer.
    await gen.next();
    await vi.advanceTimersByTimeAsync(10);

    /*
     * Aborting ends the queue, which drains what is buffered and then finishes. Without
     * it the consumer parks on an empty queue behind a BUILDING deployment that never
     * settles, and fake timers mean nothing ever wakes it.
     */
    controller.abort();

    const events: MonitorEvent[] = [];
    for await (const event of gen) events.push(event);

    const warnings = events.filter((e) => e.type === "warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ message: { key: "errors.logsTruncated" } });

    // The tail survives; it is the head that is discarded.
    const logs = events.filter((e) => e.type === "log");
    expect(logs.at(-1)).toMatchObject({ line: { message: `line ${burst - 1}` } });
    expect(logs.length).toBeLessThan(burst);
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
