import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STREAM } from "@/lib/constants";
import { useDeploymentStream } from "./use-deployment-stream";

/**
 * Minimal EventSource stand-in. jsdom has none, and the real one would need a server;
 * this exposes the handlers so a test can push server frames deterministically.
 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  /** Mirrors the real constants; the hook reads them to tell fatal from retryable. */
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  closed = false;
  onerror: (() => void) | null = null;
  /** What the browser would report; CONNECTING means it is already redialling. */
  readyState = FakeEventSource.CONNECTING;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: (event: MessageEvent) => void) {
    const existing = this.listeners.get(type) ?? [];
    this.listeners.set(type, [...existing, handler]);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, data: unknown) {
    for (const handler of this.listeners.get(type) ?? []) {
      handler({ data: JSON.stringify(data) } as MessageEvent);
    }
  }

  emitRaw(type: string, data: string) {
    for (const handler of this.listeners.get(type) ?? []) {
      handler({ data } as MessageEvent);
    }
  }

  static latest() {
    const last = FakeEventSource.instances.at(-1);
    if (!last) throw new Error("no EventSource was opened");
    return last;
  }
}

function Probe({
  deploymentId,
  enabled = true,
  phase = "deploy",
}: {
  deploymentId: string | null;
  enabled?: boolean;
  phase?: "build" | "deploy";
}) {
  const stream = useDeploymentStream(deploymentId, phase, enabled);
  return (
    <div>
      <span data-testid="state">{stream.state ?? "none"}</span>
      <span data-testid="status">{stream.status}</span>
      <span data-testid="done">{String(stream.done)}</span>
      <span data-testid="logs">{stream.logs.map((l) => l.message).join(",")}</span>
      <span data-testid="warning">{stream.warning ?? ""}</span>
      <span data-testid="error">{stream.error ?? ""}</span>
      <span data-testid="failure">
        {stream.failure ? `${stream.failure.step}|${stream.failure.reason}` : ""}
      </span>
    </div>
  );
}

const text = (id: string) => screen.getByTestId(id).textContent;

describe("useDeploymentStream", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("opens no connection when disabled", () => {
    render(<Probe deploymentId="dep_1" enabled={false} />);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("opens no connection without a deployment id", () => {
    render(<Probe deploymentId={null} />);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("requests the phase it was asked for", () => {
    render(<Probe deploymentId="dep_1" />);
    expect(FakeEventSource.latest().url).toBe("/api/streams/dep_1?phase=deploy");
  });

  it("accumulates logs and reflects status", () => {
    render(<Probe deploymentId="dep_1" />);
    const source = FakeEventSource.latest();

    act(() => {
      source.emit("ready", { backfilled: 0 });
      source.emit("log", { line: { timestamp: "t", message: "one" } });
      source.emit("log", { line: { timestamp: "t", message: "two" } });
      source.emit("status", { state: "building", rawStatus: "BUILDING" });
    });

    expect(text("status")).toBe("live");
    expect(text("logs")).toBe("one,two");
    expect(text("state")).toBe("building");
  });

  it("bounds the log buffer", () => {
    // A chatty container must not grow the tab's memory without limit.
    render(<Probe deploymentId="dep_1" />);
    const source = FakeEventSource.latest();

    act(() => {
      for (let i = 0; i < STREAM.MAX_BUFFERED_LINES + 25; i++) {
        source.emit("log", { line: { timestamp: "t", message: `line${i}` } });
      }
    });

    const lines = text("logs")!.split(",");
    expect(lines).toHaveLength(STREAM.MAX_BUFFERED_LINES);
    // The tail is what matters — the newest lines are kept.
    expect(lines.at(-1)).toBe(`line${STREAM.MAX_BUFFERED_LINES + 24}`);
  });

  it("closes the connection on done, so EventSource does not redial", () => {
    render(<Probe deploymentId="dep_1" />);
    const source = FakeEventSource.latest();

    act(() => source.emit("done", { state: "running" }));

    expect(text("done")).toBe("true");
    expect(text("status")).toBe("closed");
    expect(source.closed).toBe(true);
  });

  it("treats a payload-bearing error as terminal but a bare one as a retryable blip", () => {
    render(<Probe deploymentId="dep_1" />);
    const source = FakeEventSource.latest();

    act(() => source.emitRaw("error", "not json"));
    expect(text("error")).toBe("");
    expect(text("status")).toBe("connecting");
    expect(source.closed).toBe(false);

    act(() => source.emit("error", { message: "Authorization revoked" }));
    expect(text("error")).toBe("Authorization revoked");
    expect(source.closed).toBe(true);
  });

  it("stops waiting when the browser gives up on the connection", () => {
    /*
     * EventSource never exposes a status code, so a 400, a 401 and a 429 all arrive as
     * the same bare error event. What it does expose is readyState: CONNECTING means it
     * is already redialling, CLOSED means it has given up. Both used to be read as a
     * blip, so any non-2xx left the pane waiting on a reconnection nobody was making —
     * no console error, no failed request visible, forever.
     */
    render(<Probe deploymentId="dep_1" />);
    const source = FakeEventSource.latest();

    act(() => {
      source.readyState = FakeEventSource.CLOSED;
      source.emitRaw("error", "");
    });

    expect(text("status")).toBe("closed");
    expect(text("done")).toBe("false");
  });

  it("keeps the build output when the same deployment switches to deploy logs", () => {
    /*
     * Build and deploy are one continuous log to the person reading it. Tagging the
     * state with the phase discarded everything the build had emitted at exactly the
     * moment the build finished — which is when it becomes worth reading.
     */
    const { rerender } = render(<Probe deploymentId="dep_1" phase="build" />);
    act(() =>
      FakeEventSource.latest().emit("log", {
        line: { timestamp: "t", message: "compiling" },
      }),
    );
    const build = FakeEventSource.latest();

    rerender(<Probe deploymentId="dep_1" phase="deploy" />);

    expect(build.closed).toBe(true);
    expect(FakeEventSource.latest().url).toContain("phase=deploy");
    expect(text("logs")).toBe("compiling");
  });

  describe("when a stream re-attaches", () => {
    /** Replays the server's shape: the backfill lines, then `ready` naming how many. */
    const attach = (source: FakeEventSource, messages: string[]) =>
      act(() => {
        for (const message of messages) {
          source.emit("log", { line: { timestamp: "t", message } });
        }
        source.emit("ready", { backfilled: messages.length });
      });

    it("does not show the backfill twice", () => {
      /*
       * Every attach backfills — that is what closes the gap a dropped connection left —
       * and the buffer survives a reconnect, so without a cancel the history stacks.
       */
      render(<Probe deploymentId="dep_1" />);
      const source = FakeEventSource.latest();

      attach(source, ["one", "two", "three"]);
      attach(source, ["one", "two", "three"]);

      expect(text("logs")).toBe("one,two,three");
    });

    it("keeps the lines the re-attach actually recovered", () => {
      // The reconnect dropped after "two" and the backfill reaches back past it. Cancelling
      // the whole backfill would leave the hole the backfill was fetched to close.
      render(<Probe deploymentId="dep_1" />);
      const source = FakeEventSource.latest();

      attach(source, ["one", "two"]);
      attach(source, ["two", "three", "four"]);

      expect(text("logs")).toBe("one,two,three,four");
    });

    it("keeps both phases when a re-dial brings different output", () => {
      /*
       * Build and deploy share nothing, so the cancel finds no overlap and the build
       * output stays put. This sits beside the phase test above deliberately: that one
       * pins that the buffer survives, this one pins that the cancel does not eat it.
       */
      const { rerender } = render(<Probe deploymentId="dep_1" phase="build" />);
      attach(FakeEventSource.latest(), ["compiling", "built"]);

      rerender(<Probe deploymentId="dep_1" phase="deploy" />);
      attach(FakeEventSource.latest(), ["starting", "listening"]);

      expect(text("logs")).toBe("compiling,built,starting,listening");
    });

    it("ignores a count that cannot describe the buffer", () => {
      // A `ready` naming more lines than the buffer holds says the two disagree about what
      // happened, and guessing at a split point there would cancel real output.
      render(<Probe deploymentId="dep_1" />);
      const source = FakeEventSource.latest();

      act(() => {
        source.emit("log", { line: { timestamp: "t", message: "one" } });
        source.emit("ready", { backfilled: 99 });
      });

      expect(text("logs")).toBe("one");
      expect(text("status")).toBe("live");
    });

    it("stays live when ready carries no count at all", () => {
      render(<Probe deploymentId="dep_1" />);
      const source = FakeEventSource.latest();

      act(() => source.emitRaw("ready", "not json"));

      expect(text("status")).toBe("live");
    });
  });

  it("surfaces warnings without ending the stream", () => {
    render(<Probe deploymentId="dep_1" />);
    const source = FakeEventSource.latest();

    act(() => source.emit("warning", { message: "Could not load earlier logs" }));

    expect(text("warning")).toBe("Could not load earlier logs");
    expect(source.closed).toBe(false);
  });

  it("keeps a failure reason without closing the stream", () => {
    /*
     * The server sends this before the drain window and `done` a drain later. Closing
     * here would cut off the trailing log frames that window exists to deliver.
     */
    render(<Probe deploymentId="dep_1" />);
    const source = FakeEventSource.latest();

    act(() =>
      source.emit("failure", { step: "BUILD_IMAGE", reason: "manifest not found" }),
    );

    expect(text("failure")).toBe("BUILD_IMAGE|manifest not found");
    expect(text("done")).toBe("false");
    expect(source.closed).toBe(false);
  });

  it("keeps a failure that names no step", () => {
    // Railway can carry text on an event whose step this app does not model.
    render(<Probe deploymentId="dep_1" />);
    const source = FakeEventSource.latest();

    act(() => source.emit("failure", { step: null, reason: "pull refused" }));

    expect(text("failure")).toBe("null|pull refused");
  });

  it("ignores a malformed failure frame rather than dropping what it had", () => {
    render(<Probe deploymentId="dep_1" />);
    const source = FakeEventSource.latest();

    act(() => source.emit("failure", { step: "HEALTHCHECK", reason: "no response" }));
    act(() => source.emitRaw("failure", "not json"));

    expect(text("failure")).toBe("HEALTHCHECK|no response");
  });

  it("does not leak one container's logs into another", () => {
    // State is tagged with the stream it belongs to; switching rows must reset it.
    const { rerender } = render(<Probe deploymentId="dep_1" />);
    act(() =>
      FakeEventSource.latest().emit("log", {
        line: { timestamp: "t", message: "old" },
      }),
    );
    expect(text("logs")).toBe("old");

    rerender(<Probe deploymentId="dep_2" />);

    expect(text("logs")).toBe("");
    expect(text("state")).toBe("none");
    expect(FakeEventSource.latest().url).toContain("dep_2");
  });

  it("starts clean when the same deployment is re-attached", () => {
    /*
     * Collapsing and re-expanding a row detaches and re-attaches the same
     * deploymentId:phase. Retaining the previous attachment's state meant the server's
     * backfill was appended to logs that were already there — every line twice — and
     * `done` flipped false → true again, firing container-row's settle refresh a second
     * time for a container that had settled long ago.
     */
    const { rerender } = render(<Probe deploymentId="dep_1" />);
    act(() => {
      FakeEventSource.latest().emit("log", {
        line: { timestamp: "t", message: "first run" },
      });
      FakeEventSource.latest().emit("done", {});
    });
    expect(text("logs")).toBe("first run");
    expect(text("done")).toBe("true");

    rerender(<Probe deploymentId="dep_1" enabled={false} />);
    expect(text("logs")).toBe("");
    expect(text("done")).toBe("false");

    rerender(<Probe deploymentId="dep_1" enabled />);

    expect(text("logs")).toBe("");
    expect(text("done")).toBe("false");

    act(() =>
      FakeEventSource.latest().emit("log", {
        line: { timestamp: "t", message: "backfill" },
      }),
    );
    expect(text("logs")).toBe("backfill");
  });

  it("closes the connection on unmount", () => {
    const { unmount } = render(<Probe deploymentId="dep_1" />);
    const source = FakeEventSource.latest();
    unmount();
    expect(source.closed).toBe(true);
  });
});
