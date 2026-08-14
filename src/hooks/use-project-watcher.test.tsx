import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routerMock } from "@/test/setup-dom";
import { useProjectWatcher } from "./use-project-watcher";
import { __resetRefreshThrottle } from "./use-throttled-refresh";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly CLOSED = 2;

  readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  closed = false;
  readyState = FakeEventSource.CONNECTING;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: (event: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, data: unknown = {}) {
    for (const handler of this.listeners.get(type) ?? []) {
      handler({ data: JSON.stringify(data) } as MessageEvent);
    }
  }

  static latest() {
    const last = FakeEventSource.instances.at(-1);
    if (!last) throw new Error("no EventSource was opened");
    return last;
  }
}

function Probe({
  projectId = "p1",
  environmentId = "e1",
}: {
  projectId?: string | null;
  environmentId?: string | null;
}) {
  useProjectWatcher(projectId, environmentId);
  return null;
}

/** jsdom has no way to set visibilityState directly. */
function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    value: state,
    configurable: true,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useProjectWatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    routerMock.refresh.mockClear();
    // Shared across the tab by design, so it outlives a test unless reset.
    __resetRefreshThrottle();
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("watches the selected project and environment", () => {
    render(<Probe />);
    expect(FakeEventSource.latest().url).toBe("/api/watch/p1?environment=e1");
  });

  it("holds nothing until there is something to watch", () => {
    render(<Probe projectId={null} />);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("refreshes when the server says the project changed", () => {
    render(<Probe />);
    act(() => FakeEventSource.latest().emit("changed"));
    expect(routerMock.refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes when the server says the readouts have gone stale", () => {
    /*
     * The second reason to re-render, and it answers exactly like the first. Metrics are
     * read on the render rather than polled, so without this a project where nothing
     * changes would show whatever its CPU and memory were when the page loaded.
     */
    render(<Probe />);
    act(() => FakeEventSource.latest().emit("stale"));
    expect(routerMock.refresh).toHaveBeenCalledTimes(1);
  });

  it("debounces against the per-row settle refresh", () => {
    /*
     * A deployment finishing fires both this and container-row's own refresh inside the
     * same second. The second one is free to issue and costs two Railway round trips.
     */
    render(<Probe />);
    act(() => {
      FakeEventSource.latest().emit("changed");
      FakeEventSource.latest().emit("changed");
    });

    expect(routerMock.refresh).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(2_500);
      FakeEventSource.latest().emit("changed");
    });
    expect(routerMock.refresh).toHaveBeenCalledTimes(2);
  });

  it("costs nothing while the tab is hidden, and catches up on return", () => {
    // The whole reason this is affordable: a dashboard left open in a background tab
    // holds no connection and makes no Railway requests.
    render(<Probe />);
    const first = FakeEventSource.latest();

    act(() => setVisibility("hidden"));
    expect(first.closed).toBe(true);

    act(() => setVisibility("visible"));
    expect(routerMock.refresh).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("opens nothing at all if the tab starts hidden", () => {
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    render(<Probe />);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("reconnects with a capped backoff after a fatal failure", () => {
    render(<Probe />);

    act(() => {
      const source = FakeEventSource.latest();
      source.readyState = FakeEventSource.CLOSED;
      source.emit("error");
    });
    expect(FakeEventSource.instances).toHaveLength(1);

    act(() => vi.advanceTimersByTime(5_000));
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("leaves a transport blip to the browser's own retry", () => {
    render(<Probe />);
    act(() => FakeEventSource.latest().emit("error"));

    act(() => vi.advanceTimersByTime(60_000));
    // Still one: EventSource redials CONNECTING failures itself, and opening a second
    // connection alongside it would double the cost of a flaky network.
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("hands a revoked authorization to the proxy rather than retrying it", () => {
    render(<Probe />);
    act(() =>
      FakeEventSource.latest().emit("error", { message: "Your session expired." }),
    );

    expect(FakeEventSource.latest().closed).toBe(true);
    // The refresh is what lets the proxy redirect; retrying a revoked grant cannot help.
    expect(routerMock.refresh).toHaveBeenCalledTimes(1);
  });

  it("releases the connection on unmount", () => {
    const { unmount } = render(<Probe />);
    const source = FakeEventSource.latest();
    unmount();
    expect(source.closed).toBe(true);
  });
});
