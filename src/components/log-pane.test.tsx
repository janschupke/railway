import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { UI } from "@/lib/constants";
import type { LogLine } from "@/lib/railway/types";
import { LogPane } from "./log-pane";

const lines = (count: number): LogLine[] =>
  Array.from({ length: count }, (_, i) => ({
    timestamp: `2026-08-12T10:00:0${i % 10}Z`,
    message: `line ${i}`,
  }));

/** jsdom reports every element as zero-height, so scroll geometry has to be faked. */
function stubGeometry(
  el: HTMLElement,
  geometry: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  Object.defineProperty(el, "scrollHeight", {
    value: geometry.scrollHeight,
    configurable: true,
  });
  Object.defineProperty(el, "clientHeight", {
    value: geometry.clientHeight,
    configurable: true,
  });
  Object.defineProperty(el, "scrollTop", {
    value: geometry.scrollTop,
    writable: true,
    configurable: true,
  });
}

const viewport = () => screen.getByRole("log");

describe("LogPane", () => {
  it("announces output politely, not assertively", () => {
    // A build emits hundreds of lines; assertive would make the page unusable.
    render(<LogPane lines={[]} status="live" />);
    expect(viewport()).toHaveAttribute("aria-live", "polite");
    expect(viewport()).toHaveAccessibleName("Container logs");
  });

  it("says something different in each of the three empty states", () => {
    /*
     * The third state is the whole point. With a boolean, "the server hung up having
     * emitted nothing" was indistinguishable from "has not attached yet", so a deployment
     * that succeeded with no log output sat on "Connecting…" forever — a clean 200, no
     * console error, no failed request, and a pane that never resolved.
     */
    const { rerender } = render(<LogPane lines={[]} status="connecting" />);
    expect(screen.getByText("Connecting…")).toBeInTheDocument();

    rerender(<LogPane lines={[]} status="live" />);
    expect(screen.getByText("Waiting for output…")).toBeInTheDocument();

    rerender(<LogPane lines={[]} status="closed" />);
    expect(screen.getByText("No log output for this deployment.")).toBeInTheDocument();
    expect(screen.queryByText("Connecting…")).toBeNull();
  });

  it("ignores the caller's empty label once the stream has closed", () => {
    // emptyLabel describes a live-but-quiet stream. A closed one is not waiting for
    // anything, and saying so was how the hang read as normal.
    render(<LogPane lines={[]} status="closed" emptyLabel="Waiting for output…" />);
    expect(screen.getByText("No log output for this deployment.")).toBeInTheDocument();
  });

  it("accepts a caller-supplied empty message", () => {
    render(<LogPane lines={[]} status="live" emptyLabel="No log output." />);
    expect(screen.getByText("No log output.")).toBeInTheDocument();
  });

  it("renders each line with its clock time", () => {
    render(
      <LogPane
        lines={[{ timestamp: "2026-08-12T10:34:56Z", message: "boot" }]}
        status="live"
      />,
    );

    expect(screen.getByText("boot")).toBeInTheDocument();
    expect(screen.getByText("10:34:56")).toBeInTheDocument();
  });

  it("falls back to placeholder digits for a line with no timestamp", () => {
    render(<LogPane lines={[{ timestamp: "", message: "orphan" }]} status="live" />);
    expect(screen.getByText("--:--:--")).toBeInTheDocument();
  });

  it("stays pinned to the tail while the reader is at the bottom", () => {
    const { rerender } = render(<LogPane lines={lines(3)} status="live" />);
    const el = viewport();
    stubGeometry(el, { scrollHeight: 500, clientHeight: 100, scrollTop: 400 });

    rerender(<LogPane lines={lines(4)} status="live" />);

    expect(el.scrollTop).toBe(500);
    expect(screen.queryByRole("button", { name: /jump to latest/i })).toBeNull();
  });

  it("detaches when the reader scrolls up, and offers a way back", async () => {
    // Tailing that fights the user is worse than no tailing: you cannot read a
    // failure while it scrolls away.
    const user = userEvent.setup();
    const { rerender } = render(<LogPane lines={lines(3)} status="live" />);
    const el = viewport();

    stubGeometry(el, { scrollHeight: 500, clientHeight: 100, scrollTop: 0 });
    fireEvent.scroll(el);

    rerender(<LogPane lines={lines(4)} status="live" />);
    expect(el.scrollTop).toBe(0);

    const jump = screen.getByRole("button", { name: /jump to latest/i });
    await user.click(jump);

    expect(el.scrollTop).toBe(500);
    expect(screen.queryByRole("button", { name: /jump to latest/i })).toBeNull();
  });

  it("stays pinned within the threshold, so a stray pixel does not detach it", () => {
    const { rerender } = render(<LogPane lines={lines(3)} status="live" />);
    const el = viewport();

    stubGeometry(el, {
      scrollHeight: 500,
      clientHeight: 100,
      scrollTop: 400 - UI.AUTOSCROLL_THRESHOLD_PX,
    });
    fireEvent.scroll(el);
    rerender(<LogPane lines={lines(4)} status="live" />);

    expect(screen.queryByRole("button", { name: /jump to latest/i })).toBeNull();
  });
});
