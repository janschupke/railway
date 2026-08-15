import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { LIMITS } from "@/lib/constants";
import { useBulkSelection } from "./use-bulk-selection";

const item = (serviceId: string) => ({ serviceId });

/** The hook with nothing around it: a tick per row, and a readout of what it decided. */
function Harness({
  items,
  listKey,
}: {
  items: readonly { serviceId: string }[];
  listKey: string;
}) {
  const { selected, setSelected, selectAll, allSelected, capped } = useBulkSelection(
    items,
    listKey,
  );
  return (
    <div>
      {items.map((one) => (
        <button
          key={one.serviceId}
          type="button"
          onClick={() =>
            setSelected(
              one.serviceId,
              !selected.some((s) => s.serviceId === one.serviceId),
            )
          }
        >
          {one.serviceId}
        </button>
      ))}
      <button type="button" onClick={() => selectAll(true)}>
        all
      </button>
      <button type="button" onClick={() => selectAll(false)}>
        none
      </button>
      <span data-testid="selected">
        {selected.map((one) => one.serviceId).join(",")}
      </span>
      <span data-testid="all">{String(allSelected)}</span>
      <span data-testid="capped">{String(capped.length)}</span>
    </div>
  );
}

const selected = () => screen.getByTestId("selected").textContent;

describe("useBulkSelection", () => {
  it("ticks and unticks one row at a time", async () => {
    const user = userEvent.setup();
    render(<Harness items={[item("a"), item("b")]} listKey="k" />);

    await user.click(screen.getByRole("button", { name: "a" }));
    expect(selected()).toBe("a");
    await user.click(screen.getByRole("button", { name: "b" }));
    expect(selected()).toBe("a,b");
    await user.click(screen.getByRole("button", { name: "a" }));
    expect(selected()).toBe("b");
  });

  it("orders the selection by the list, not by click order", async () => {
    // So a confirmation dialog reads in the order the rows are on screen.
    const user = userEvent.setup();
    render(<Harness items={[item("a"), item("b"), item("c")]} listKey="k" />);

    await user.click(screen.getByRole("button", { name: "c" }));
    await user.click(screen.getByRole("button", { name: "a" }));
    expect(selected()).toBe("a,c");
  });

  it("drops a row that has left the selectable set", async () => {
    /*
     * The set of ids is a record of what was ticked; `selected` is the answer to what that
     * currently means. A row destroyed, filtered away or found not to be ours cannot reach
     * a confirmation just because its id is still in the set.
     */
    const user = userEvent.setup();
    const { rerender } = render(<Harness items={[item("a"), item("b")]} listKey="k" />);

    await user.click(screen.getByRole("button", { name: "a" }));
    await user.click(screen.getByRole("button", { name: "b" }));
    expect(selected()).toBe("a,b");

    rerender(<Harness items={[item("b")]} listKey="k" />);
    expect(selected()).toBe("b");
  });

  it("clears the selection when the list key changes", async () => {
    // Changing what you are looking at clears what you had picked, which is what keeps a
    // row hidden by a filter out of the batch.
    const user = userEvent.setup();
    const { rerender } = render(<Harness items={[item("a"), item("b")]} listKey="k" />);

    await user.click(screen.getByRole("button", { name: "a" }));
    expect(selected()).toBe("a");

    rerender(<Harness items={[item("a"), item("b")]} listKey="other" />);
    expect(selected()).toBe("");
  });

  it("selects all and clears all", async () => {
    const user = userEvent.setup();
    render(<Harness items={[item("a"), item("b")]} listKey="k" />);

    await user.click(screen.getByRole("button", { name: "all" }));
    expect(selected()).toBe("a,b");
    expect(screen.getByTestId("all").textContent).toBe("true");

    await user.click(screen.getByRole("button", { name: "none" }));
    expect(selected()).toBe("");
    expect(screen.getByTestId("all").textContent).toBe("false");
  });

  it("is not `all selected` when there is nothing to select", () => {
    render(<Harness items={[]} listKey="k" />);
    expect(screen.getByTestId("all").textContent).toBe("false");
  });

  it("caps select-all at what one request may carry", async () => {
    /*
     * A tick that quietly selected fifty of eighty is the list telling the user something
     * untrue about their own selection. The cap is exposed so the caller can say so.
     */
    const user = userEvent.setup();
    const many = Array.from({ length: LIMITS.BULK_DESTROY_MAX + 5 }, (_, index) =>
      item(`s${index}`),
    );
    render(<Harness items={many} listKey="k" />);

    expect(screen.getByTestId("capped").textContent).toBe(
      String(LIMITS.BULK_DESTROY_MAX),
    );
    await user.click(screen.getByRole("button", { name: "all" }));
    expect(selected()!.split(",")).toHaveLength(LIMITS.BULK_DESTROY_MAX);
    // Capped and complete are the same thing here, or the checkbox would never settle.
    expect(screen.getByTestId("all").textContent).toBe("true");
  });
});
