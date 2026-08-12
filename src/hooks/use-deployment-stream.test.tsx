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
  readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  closed = false;
  onerror: (() => void) | null = null;

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
}: {
  deploymentId: string | null;
  enabled?: boolean;
}) {
  const stream = useDeploymentStream(deploymentId, "deploy", enabled);
  return (
    <div>
      <span data-testid="state">{stream.state ?? "none"}</span>
      <span data-testid="connected">{String(stream.connected)}</span>
      <span data-testid="done">{String(stream.done)}</span>
      <span data-testid="logs">{stream.logs.map((l) => l.message).join(",")}</span>
      <span data-testid="warning">{stream.warning ?? ""}</span>
      <span data-testid="error">{stream.error ?? ""}</span>
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

    expect(text("connected")).toBe("true");
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
    expect(text("connected")).toBe("false");
    expect(source.closed).toBe(true);
  });

  it("treats a payload-bearing error as terminal but a bare one as a retryable blip", () => {
    render(<Probe deploymentId="dep_1" />);
    const source = FakeEventSource.latest();

    act(() => source.emitRaw("error", "not json"));
    expect(text("error")).toBe("");
    expect(source.closed).toBe(false);

    act(() => source.emit("error", { message: "Authorization revoked" }));
    expect(text("error")).toBe("Authorization revoked");
    expect(source.closed).toBe(true);
  });

  it("surfaces warnings without ending the stream", () => {
    render(<Probe deploymentId="dep_1" />);
    const source = FakeEventSource.latest();

    act(() => source.emit("warning", { message: "Could not load earlier logs" }));

    expect(text("warning")).toBe("Could not load earlier logs");
    expect(source.closed).toBe(false);
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
