import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UI } from "@/lib/constants";
import { clipboardMock } from "@/test/setup-dom";
import type { LogLine } from "@/lib/railway/types";
import { LogPane } from "./log-pane";
import { ToastProvider } from "./ui/toast";

const lines = (count: number): LogLine[] =>
  Array.from({ length: count }, (_, i) => ({
    timestamp: `2026-08-12T10:00:0${i % 10}Z`,
    message: `line ${i}`,
  }));

type PaneProps = Omit<React.ComponentProps<typeof LogPane>, "label"> & {
  label?: string;
};

/** ToastProvider because copy reports its outcome through it, as the dashboard does. */
function renderPane(props: PaneProps) {
  const ui = ({ label = "cache", ...rest }: PaneProps) => (
    <ToastProvider>
      <LogPane label={label} {...rest} />
    </ToastProvider>
  );
  const result = render(ui(props));
  return { ...result, rerender: (next: PaneProps) => result.rerender(ui(next)) };
}

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

/** Rows have no layout either, so the jump-to-match arithmetic needs its own stubs. */
function stubRows(height = 100) {
  document.querySelectorAll<HTMLElement>("[data-log-row]").forEach((row, i) => {
    Object.defineProperty(row, "offsetTop", { value: i * height, configurable: true });
    Object.defineProperty(row, "offsetHeight", { value: height, configurable: true });
  });
}

const viewport = () => screen.getByRole("log");
const rows = () => [...document.querySelectorAll<HTMLElement>("[data-log-row]")];
const marks = () => [...document.querySelectorAll<HTMLElement>("mark")];
const currentMark = () => document.querySelector("[data-log-match='current']");
const button = (name: RegExp | string) => screen.getByRole("button", { name });

describe("LogPane", () => {
  it("announces output politely, not assertively", () => {
    /*
     * A build emits hundreds of lines; assertive would make the page unusable.
     *
     * Asserted through role="log", which carries an implicit polite live region — the
     * explicit aria-live said nothing the role did not, and on a dashboard already
     * holding several regions the redundant one is the cheapest to remove. What must
     * stay true is that this is a log region and that it is not assertive.
     */
    renderPane({ lines: [], status: "live" });
    expect(viewport()).toHaveAttribute("role", "log");
    expect(viewport()).not.toHaveAttribute("aria-live", "assertive");
    expect(viewport()).toHaveAccessibleName("Container logs");
  });

  it("says something different in each of the three empty states", () => {
    /*
     * The third state is the whole point. With a boolean, "the server hung up having
     * emitted nothing" was indistinguishable from "has not attached yet", so a deployment
     * that succeeded with no log output sat on "Connecting…" forever — a clean 200, no
     * console error, no failed request, and a pane that never resolved.
     */
    const { rerender } = renderPane({ lines: [], status: "connecting" });
    expect(screen.getByText("Connecting…")).toBeInTheDocument();

    rerender({ lines: [], status: "live" });
    expect(screen.getByText("Waiting for output…")).toBeInTheDocument();

    rerender({ lines: [], status: "closed" });
    expect(screen.getByText("No log output for this deployment.")).toBeInTheDocument();
    expect(screen.queryByText("Connecting…")).toBeNull();
  });

  it("ignores the caller's empty label once the stream has closed", () => {
    // emptyLabel describes a live-but-quiet stream. A closed one is not waiting for
    // anything, and saying so was how the hang read as normal.
    renderPane({ lines: [], status: "closed", emptyLabel: "Waiting for output…" });
    expect(screen.getByText("No log output for this deployment.")).toBeInTheDocument();
  });

  it("accepts a caller-supplied empty message", () => {
    renderPane({ lines: [], status: "live", emptyLabel: "No log output." });
    expect(screen.getByText("No log output.")).toBeInTheDocument();
  });

  it("renders each line with its clock time", () => {
    renderPane({
      lines: [{ timestamp: "2026-08-12T10:34:56Z", message: "boot" }],
      status: "live",
    });

    expect(screen.getByText("boot")).toBeInTheDocument();
    expect(screen.getByText("10:34:56")).toBeInTheDocument();
  });

  it("falls back to placeholder digits for a line with no timestamp", () => {
    renderPane({ lines: [{ timestamp: "", message: "orphan" }], status: "live" });
    expect(screen.getByText("--:--:--")).toBeInTheDocument();
  });

  it("stays pinned to the tail while the reader is at the bottom", () => {
    const { rerender } = renderPane({ lines: lines(3), status: "live" });
    const el = viewport();
    stubGeometry(el, { scrollHeight: 500, clientHeight: 100, scrollTop: 400 });

    rerender({ lines: lines(4), status: "live" });

    expect(el.scrollTop).toBe(500);
    expect(screen.queryByRole("button", { name: /jump to latest/i })).toBeNull();
  });

  it("detaches when the reader scrolls up, and offers a way back", async () => {
    // Tailing that fights the user is worse than no tailing: you cannot read a
    // failure while it scrolls away.
    const user = userEvent.setup();
    const { rerender } = renderPane({ lines: lines(3), status: "live" });
    const el = viewport();

    stubGeometry(el, { scrollHeight: 500, clientHeight: 100, scrollTop: 0 });
    fireEvent.scroll(el);

    rerender({ lines: lines(4), status: "live" });
    expect(el.scrollTop).toBe(0);

    const jump = button(/jump to latest/i);
    await user.click(jump);

    expect(el.scrollTop).toBe(500);
    expect(screen.queryByRole("button", { name: /jump to latest/i })).toBeNull();
  });

  it("stays pinned within the threshold, so a stray pixel does not detach it", () => {
    const { rerender } = renderPane({ lines: lines(3), status: "live" });
    const el = viewport();

    stubGeometry(el, {
      scrollHeight: 500,
      clientHeight: 100,
      scrollTop: 400 - UI.AUTOSCROLL_THRESHOLD_PX,
    });
    fireEvent.scroll(el);
    rerender({ lines: lines(4), status: "live" });

    expect(screen.queryByRole("button", { name: /jump to latest/i })).toBeNull();
  });
});

describe("LogPane search", () => {
  it("offers its controls disabled rather than absent while there is nothing to act on", () => {
    // A control that appears is a control that reflows the row at the moment the user is
    // aiming at something else — the rule the filter bar's Clear button already follows.
    renderPane({ lines: [], status: "connecting" });

    expect(button("Next match")).toBeDisabled();
    expect(button("Previous match")).toBeDisabled();
    expect(button("Copy these lines")).toBeDisabled();
    expect(button("Download these lines")).toBeDisabled();
    expect(button("Wrap long lines")).toBeEnabled();
  });

  it("highlights matches and counts them", async () => {
    const user = userEvent.setup();
    renderPane({ lines: lines(3), status: "live" });

    await user.type(screen.getByRole("searchbox"), "line");

    expect(marks()).toHaveLength(3);
    expect(screen.getByText("Match 1 of 3")).toBeInTheDocument();
  });

  it("asks for a longer needle rather than marking most of the buffer", async () => {
    // One character matches nearly every line, which is tens of thousands of elements
    // rebuilt per keystroke for an answer that says nothing.
    const user = userEvent.setup();
    renderPane({ lines: lines(3), status: "live" });

    await user.type(screen.getByRole("searchbox"), "l");

    expect(marks()).toHaveLength(0);
    expect(
      screen.getByText("Type at least 2 characters to search."),
    ).toBeInTheDocument();
  });

  it("says so when a needle matches nothing", async () => {
    const user = userEvent.setup();
    renderPane({ lines: lines(3), status: "live" });

    await user.type(screen.getByRole("searchbox"), "zzz");

    expect(screen.getByText("No matches in these lines.")).toBeInTheDocument();
    expect(button("Next match")).toBeDisabled();
  });

  it("steps forward and back with Enter, wrapping at both ends", async () => {
    const user = userEvent.setup();
    renderPane({ lines: lines(3), status: "live" });
    const field = screen.getByRole("searchbox");

    await user.type(field, "line");
    expect(screen.getByText("Match 1 of 3")).toBeInTheDocument();

    await user.type(field, "{Enter}");
    expect(screen.getByText("Match 2 of 3")).toBeInTheDocument();

    await user.type(field, "{Shift>}{Enter}{/Shift}");
    expect(screen.getByText("Match 1 of 3")).toBeInTheDocument();

    await user.type(field, "{Shift>}{Enter}{/Shift}");
    expect(screen.getByText("Match 3 of 3")).toBeInTheDocument();
  });

  it("distinguishes the current match from the rest", async () => {
    const user = userEvent.setup();
    renderPane({ lines: lines(3), status: "live" });

    await user.type(screen.getByRole("searchbox"), "line");

    expect(currentMark()).toHaveTextContent("line");
    expect(document.querySelectorAll("[data-log-match='current']")).toHaveLength(1);
    expect(document.querySelectorAll("[data-log-match='other']")).toHaveLength(2);
  });

  it("scrolls the current match into view and lets go of the tail", async () => {
    const user = userEvent.setup();
    renderPane({ lines: lines(4), status: "live" });
    const el = viewport();
    stubGeometry(el, { scrollHeight: 500, clientHeight: 100, scrollTop: 400 });
    stubRows();

    await user.type(screen.getByRole("searchbox"), "line");
    await user.type(screen.getByRole("searchbox"), "{Enter}");

    // Row 1 centred in a 100px viewport that shows exactly one 100px row.
    expect(el.scrollTop).toBe(100);
    expect(button(/jump to latest/i)).toBeInTheDocument();
  });

  it("does not yank back to the tail when a line arrives after a jump", async () => {
    /*
     * The regression this pane's effect ordering exists for. A jump detaches, and mid
     * build a log frame commits every tick — if the autoscroll effect won that commit,
     * the match the reader just navigated to would scroll away under them.
     */
    const user = userEvent.setup();
    const { rerender } = renderPane({ lines: lines(4), status: "live" });
    const el = viewport();
    stubGeometry(el, { scrollHeight: 500, clientHeight: 100, scrollTop: 400 });
    stubRows();

    await user.type(screen.getByRole("searchbox"), "line");
    await user.type(screen.getByRole("searchbox"), "{Enter}");
    expect(el.scrollTop).toBe(100);

    rerender({ lines: lines(5), status: "live" });

    expect(el.scrollTop).toBe(100);
  });

  it("clears the needle on Escape", async () => {
    const user = userEvent.setup();
    renderPane({ lines: lines(3), status: "live" });
    const field = screen.getByRole("searchbox");

    await user.type(field, "line");
    expect(marks()).toHaveLength(3);

    await user.type(field, "{Escape}");

    expect(field).toHaveValue("");
    expect(marks()).toHaveLength(0);
  });

  it("holds the log region's own announcements while a needle is present", async () => {
    // Replacing text nodes with elements across every matching row reads to the region
    // as a burst of additions; the match counter is the useful channel while searching.
    const user = userEvent.setup();
    renderPane({ lines: lines(3), status: "live" });
    expect(viewport()).not.toHaveAttribute("aria-busy");

    await user.type(screen.getByRole("searchbox"), "line");
    expect(viewport()).toHaveAttribute("aria-busy", "true");

    await user.type(screen.getByRole("searchbox"), "{Escape}");
    expect(viewport()).not.toHaveAttribute("aria-busy");
  });
});

describe("LogPane wrap", () => {
  it("reports and swaps the wrapping mode", async () => {
    const user = userEvent.setup();
    renderPane({ lines: lines(2), status: "live" });
    const toggle = button("Wrap long lines");

    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(rows()[0]).toHaveClass("whitespace-pre");

    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-pressed", "true");
    // break-all as well, because Radix's viewport wraps children in a shrink-to-fit box
    // and one unbreakable token would otherwise keep the horizontal scrollbar alive.
    expect(rows()[0]).toHaveClass("whitespace-pre-wrap", "break-all");
  });

  it("keeps a pinned pane at the tail across a wrap toggle", async () => {
    // Wrapping changes every row's height, so scrollHeight moves under the viewport.
    const user = userEvent.setup();
    renderPane({ lines: lines(3), status: "live" });
    const el = viewport();
    stubGeometry(el, { scrollHeight: 800, clientHeight: 100, scrollTop: 400 });

    await user.click(button("Wrap long lines"));

    expect(el.scrollTop).toBe(800);
  });
});

describe("LogPane severity filter", () => {
  const mixed: LogLine[] = [
    { timestamp: "2026-08-12T10:00:00Z", message: "starting", severity: "info" },
    { timestamp: "2026-08-12T10:00:01Z", message: "pull failed", severity: "error" },
  ];

  it("renders no filter at all when nothing carries a severity", () => {
    // Railway's payload has never been observed carrying one, and a permanently empty
    // control is worse than no control.
    renderPane({ lines: lines(3), status: "live" });
    expect(screen.queryByRole("group", { name: "Severity" })).toBeNull();
  });

  it("offers exactly the severities the buffer holds, loudest last", () => {
    renderPane({ lines: mixed, status: "live" });
    const chips = screen.getAllByRole("button", { pressed: false });
    expect(chips.map((chip) => chip.textContent)).toEqual(
      expect.arrayContaining(["info", "error"]),
    );
  });

  it("narrows the pane to the selected severity", async () => {
    const user = userEvent.setup();
    renderPane({ lines: mixed, status: "live" });

    await user.click(screen.getByRole("button", { name: "error" }));

    expect(screen.queryByText("starting")).toBeNull();
    expect(screen.getByText("pull failed")).toBeInTheDocument();
  });

  it("stops narrowing when the selected severity rolls out of the buffer", async () => {
    /*
     * The 1,000-line cap drops the oldest line, so a selection can outlive its values.
     * Forgetting the choice would be wrong — the stream is still running and the value
     * may come back — and narrowing to nothing would strand the reader on an empty pane.
     */
    const user = userEvent.setup();
    const { rerender } = renderPane({ lines: mixed, status: "live" });

    await user.click(screen.getByRole("button", { name: "error" }));
    expect(screen.queryByText("starting")).toBeNull();

    rerender({ lines: mixed.slice(0, 1), status: "live" });

    expect(screen.getByText("starting")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "error" })).toBeNull();
  });
});

/*
 * fireEvent rather than user-event throughout.
 *
 * user-event installs a clipboard stub of its own for the duration of a setup() session,
 * which shadows the one these assertions are made against. Nothing here needs the extra
 * fidelity of a real pointer sequence — they are single clicks on ordinary buttons.
 */
describe("LogPane copy and download", () => {
  it("copies the buffer with its full timestamps and says how much", async () => {
    // The pane draws an eight-character clock. A file or a paste needs the date and the
    // offset back.
    renderPane({ lines: lines(2), status: "live" });

    fireEvent.click(button("Copy these lines"));

    expect(clipboardMock.writeText).toHaveBeenCalledWith(
      "2026-08-12T10:00:00Z line 0\n2026-08-12T10:00:01Z line 1\n",
    );
    expect(await screen.findByText("Copied 2 log lines")).toBeInTheDocument();
  });

  it("copies only what the severity filter left on screen", async () => {
    renderPane({
      lines: [
        { timestamp: "2026-08-12T10:00:00Z", message: "starting", severity: "info" },
        {
          timestamp: "2026-08-12T10:00:01Z",
          message: "pull failed",
          severity: "error",
        },
      ],
      status: "live",
    });

    fireEvent.click(screen.getByRole("button", { name: "error" }));
    fireEvent.click(button("Copy these lines"));

    expect(clipboardMock.writeText).toHaveBeenCalledWith(
      "2026-08-12T10:00:01Z ERROR pull failed\n",
    );
    expect(await screen.findByText("Copied one log line")).toBeInTheDocument();
  });

  it("says the clipboard refused, and names the way out", async () => {
    // Undefined on an insecure origin, rejected on a denied permission. Either way the
    // text did not go anywhere, and a silent success is the failure mode to avoid.
    clipboardMock.writeText.mockRejectedValueOnce(new Error("denied"));
    renderPane({ lines: lines(1), status: "live" });

    fireEvent.click(button("Copy these lines"));

    expect(
      await screen.findByText("The log lines could not be copied"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "The browser refused access to the clipboard. Select the lines and copy them, or download them instead.",
      ),
    ).toBeInTheDocument();
  });

  it("downloads a file named after the container, and releases the URL after", async () => {
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:log-pane");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    renderPane({ lines: lines(1), status: "live", label: "My Cache" });

    fireEvent.click(button("Download these lines"));

    const anchor = click.mock.instances[0] as HTMLAnchorElement;
    expect(anchor.download).toMatch(/^my-cache-logs-.+\.txt$/);
    expect(create).toHaveBeenCalled();
    // Not revoked inline: a synchronous revoke can abort the download the click has only
    // just started, and it fails silently — no error, no file.
    expect(revoke).not.toHaveBeenCalled();

    await waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:log-pane"));

    create.mockRestore();
    revoke.mockRestore();
    click.mockRestore();
  });
});
