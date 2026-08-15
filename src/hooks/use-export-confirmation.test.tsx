import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UI } from "@/lib/constants";
import { useExportConfirmation } from "./use-export-confirmation";

function Harness() {
  const { confirmed, confirm } = useExportConfirmation();
  return (
    <div>
      <button type="button" onClick={() => confirm("copy")}>
        copy
      </button>
      <button type="button" onClick={() => confirm("download")}>
        download
      </button>
      <span data-testid="confirmed">{confirmed ?? "none"}</span>
    </div>
  );
}

const confirmed = () => screen.getByTestId("confirmed").textContent;

afterEach(() => {
  vi.useRealTimers();
});

describe("useExportConfirmation", () => {
  it("shows nothing until an export succeeds", () => {
    render(<Harness />);
    expect(confirmed()).toBe("none");
  });

  it("shows the tick and takes it away again", async () => {
    vi.useFakeTimers();
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "copy" }));
    expect(confirmed()).toBe("copy");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(UI.ACTION_FEEDBACK_MS + 1);
    });
    expect(confirmed()).toBe("none");
  });

  it("replaces one tick with the other rather than showing both", async () => {
    // One value rather than two booleans, so the pane cannot get stuck claiming a copy and
    // a download both just happened.
    vi.useFakeTimers();
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "copy" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UI.ACTION_FEEDBACK_MS / 2);
    });
    fireEvent.click(screen.getByRole("button", { name: "download" }));
    expect(confirmed()).toBe("download");

    // The first timer is cleared, so it cannot blank the second tick early.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UI.ACTION_FEEDBACK_MS / 2 + 1);
    });
    expect(confirmed()).toBe("download");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(UI.ACTION_FEEDBACK_MS);
    });
    expect(confirmed()).toBe("none");
  });

  it("clears its timer on unmount", async () => {
    /*
     * The pane this serves is mounted behind a row's `mounted` gate. Collapsing the row
     * inside the feedback window would otherwise leave a setState scheduled against a
     * component that is gone.
     */
    vi.useFakeTimers();
    const clear = vi.spyOn(globalThis, "clearTimeout");
    const { unmount } = render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "copy" }));
    const before = clear.mock.calls.length;
    unmount();
    expect(clear.mock.calls.length).toBeGreaterThan(before);

    // And nothing is left to fire against the unmounted tree.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UI.ACTION_FEEDBACK_MS + 1);
    });
    clear.mockRestore();
  });
});
