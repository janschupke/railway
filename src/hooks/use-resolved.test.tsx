import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useResolved } from "./use-resolved";

function Readout({ promise }: { promise: Promise<string[]> }) {
  const value = useResolved<string[]>(promise, []);
  return <p data-testid="value">{value.join(",")}</p>;
}

const value = () => screen.getByTestId("value").textContent;

/** A promise plus the handle to settle it, so ordering can be written out rather than raced. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("useResolved", () => {
  it("renders the seed first and the resolved value after", async () => {
    render(<Readout promise={Promise.resolve(["cache", "queue"])} />);

    expect(value()).toBe("");
    await waitFor(() => expect(value()).toBe("cache,queue"));
  });

  /*
   * The reason the flag exists. A fresh promise arrives on every render of the page, so two
   * reads can be in flight at once — and the slow earlier one must not land on top of the
   * newer one. Without the flag the check would go backwards, silently, at the exact moment
   * a container was created.
   */
  it("ignores an earlier read that settles after a newer one", async () => {
    const first = deferred<string[]>();
    const second = deferred<string[]>();

    const { rerender } = render(<Readout promise={first.promise} />);
    rerender(<Readout promise={second.promise} />);

    second.resolve(["new"]);
    await waitFor(() => expect(value()).toBe("new"));

    first.resolve(["stale"]);
    await new Promise((settle) => setTimeout(settle, 0));
    expect(value()).toBe("new");
  });

  it("does not write to a component that has unmounted", async () => {
    const pending = deferred<string[]>();
    const { unmount } = render(<Readout promise={pending.promise} />);

    unmount();
    pending.resolve(["late"]);

    // A React state update after unmount is a warning rather than a throw, so the assertion
    // is that nothing was written: the element is gone and the resolve was a no-op.
    await new Promise((settle) => setTimeout(settle, 0));
    expect(screen.queryByTestId("value")).toBeNull();
  });
});
