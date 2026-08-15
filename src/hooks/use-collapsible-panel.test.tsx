import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UI } from "@/lib/constants";
import { useCollapsiblePanel } from "./use-collapsible-panel";

/**
 * A panel with nothing in it but the mechanism.
 *
 * The hook was fifty lines inside `container-row.tsx` and was only ever exercised through a
 * container: the two-frame open, the intent guard and the backstop are each there to defeat
 * a specific way `expanded` and `mounted` can be left disagreeing, and none of that is
 * about containers.
 */
function Panel() {
  const { expanded, mounted, triggerProps, panelProps } = useCollapsiblePanel();
  return (
    <div>
      <button type="button" {...triggerProps}>
        toggle
      </button>
      <div {...panelProps} data-testid="panel">
        {mounted ? <button type="button">inside</button> : null}
      </div>
      <span data-testid="state">{`${expanded}:${mounted}`}</span>
    </div>
  );
}

const state = () => screen.getByTestId("state").textContent;
const panel = () => screen.getByTestId("panel");

/**
 * Runs the two queued animation frames the open path waits on.
 *
 * jsdom implements rAF against its own timer, so the frames only land if something drives
 * them — which is also what makes the interrupted-open case reachable at all.
 */
const frames = async () => {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
};

afterEach(() => {
  vi.useRealTimers();
});

describe("useCollapsiblePanel", () => {
  it("starts closed, hidden and out of the tab order", () => {
    render(<Panel />);
    expect(state()).toBe("false:false");
    expect(panel()).toHaveAttribute("hidden");
    expect(screen.queryByRole("button", { name: "inside" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "toggle" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("mounts a frame before it expands, so the transition has somewhere to start", async () => {
    const user = userEvent.setup();
    render(<Panel />);

    await user.click(screen.getByRole("button", { name: "toggle" }));
    // `hidden` comes off first, at grid-rows 0fr. Expanding in the same commit would give
    // the transition no start value to interpolate from.
    expect(state()).toBe("false:true");
    expect(panel()).not.toHaveAttribute("hidden");

    await frames();
    expect(state()).toBe("true:true");
    expect(panel()).toHaveAttribute("data-panel-open", "true");
  });

  it("keeps the panel mounted while it collapses, then drops it on transitionend", async () => {
    const user = userEvent.setup();
    render(<Panel />);

    await user.click(screen.getByRole("button", { name: "toggle" }));
    await frames();

    await user.click(screen.getByRole("button", { name: "toggle" }));
    // Still mounted: `hidden` is display:none, and nothing transitions out of that.
    expect(state()).toBe("false:true");

    await act(async () => {
      panel().dispatchEvent(
        Object.assign(new Event("transitionend", { bubbles: true }), {
          propertyName: "grid-template-rows",
        }),
      );
    });
    expect(state()).toBe("false:false");
  });

  it("ignores a transitionend for some other property", async () => {
    const user = userEvent.setup();
    render(<Panel />);
    await user.click(screen.getByRole("button", { name: "toggle" }));
    await frames();

    await act(async () => {
      panel().dispatchEvent(
        Object.assign(new Event("transitionend", { bubbles: true }), {
          propertyName: "opacity",
        }),
      );
    });
    // An opacity transition on something inside the panel must not unmount it.
    expect(state()).toBe("true:true");
  });

  it("unmounts on the backstop when the transition never fires", async () => {
    /*
     * `transitionend` is not guaranteed — a panel toggled faster than the animation, or one
     * whose transition is interrupted, may never emit it. Without the backstop that leaves
     * a zero-height panel mounted: invisible, and still focusable.
     */
    /*
     * Installed before the first click: the backstop's timer is scheduled by an effect on
     * the way *in*, so faking the clock afterwards leaves a real timer pending instead.
     *
     * `fireEvent` rather than `userEvent` — the latter awaits its own delays against the
     * clock this test has just taken control of, and deadlocks.
     */
    vi.useFakeTimers();
    render(<Panel />);
    const toggle = () => screen.getByRole("button", { name: "toggle" });

    fireEvent.click(toggle());
    await act(async () => {
      // vitest fakes requestAnimationFrame too, so this drives the two-frame open.
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(state()).toBe("true:true");

    fireEvent.click(toggle());
    expect(state()).toBe("false:true");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(UI.TRANSITION_BACKSTOP_MS + 1);
    });
    expect(state()).toBe("false:false");
  });

  it("does not let a queued open re-expand a panel already dismissed", async () => {
    /*
     * The reason `intent` is a ref rather than derived state.
     *
     * `mounted && !expanded` is two different states — one frame into opening, and one
     * transition away from closed. A machine that delays the queued frames past a full
     * open-and-close used to run them anyway, setting `expanded` true over a panel the
     * user had already dismissed: the row stuck at aria-expanded="true" over a hidden
     * region, with no way back short of a reload.
     *
     * Driven by holding the frame callbacks rather than by clicking quickly, because
     * `toggle` keys on `expanded` — two fast clicks open twice, and never reach this.
     */
    const queued: FrameRequestCallback[] = [];
    const raf = vi
      .spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation((callback) => {
        queued.push(callback);
        return queued.length;
      });

    /** Runs exactly the callbacks queued right now; an inner frame lands on the next call. */
    const runQueued = async () => {
      const due = queued.splice(0, queued.length);
      await act(async () => {
        for (const callback of due) callback(0);
      });
    };

    try {
      const user = userEvent.setup();
      const toggle = () => screen.getByRole("button", { name: "toggle" });
      render(<Panel />);

      // Two opens while nothing has run, because `toggle` opens whenever it is not
      // expanded. That leaves two independent frame pairs in flight.
      await user.click(toggle());
      await user.click(toggle());
      await runQueued(); // both outer frames; each queues its inner
      expect(queued).toHaveLength(2);

      // The first inner frame lands and the panel is genuinely open.
      const inner = queued.splice(0, 2);
      const first = inner[0]!;
      const second = inner[1]!;
      await act(async () => first(0));
      expect(state()).toBe("true:true");

      // The user dismisses it — and only then does the stale second frame arrive.
      await user.click(toggle());
      expect(state()).toBe("false:true");
      await act(async () => second(0));

      expect(state()).toBe("false:true");
      expect(toggle()).toHaveAttribute("aria-expanded", "false");
    } finally {
      raf.mockRestore();
    }
  });

  it("points the trigger at the panel it controls", () => {
    render(<Panel />);
    expect(
      screen.getByRole("button", { name: "toggle" }).getAttribute("aria-controls"),
    ).toBe(panel().id);
  });
});
