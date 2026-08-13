import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NO_FILTERS, parseFilters } from "@/lib/container-filters";
import { ContainerFilterBar } from "./container-filter-bar";

const handlers = () => ({
  onDraftChange: vi.fn(),
  onFlushDraft: vi.fn(),
  onStatusesChange: vi.fn(),
  onOwnersChange: vi.fn(),
  onClear: vi.fn(),
});

const renderBar = (
  over: Partial<React.ComponentProps<typeof ContainerFilterBar>> = {},
) => {
  const spies = handlers();
  render(
    <ContainerFilterBar
      filters={NO_FILTERS}
      draft=""
      canClear={false}
      {...spies}
      {...over}
    />,
  );
  return spies;
};

/** The status dropdown, opened. Returns the group of checkboxes inside it. */
const openStatuses = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: /^Status/ }));
  return within(screen.getByRole("group", { name: "Filter by status" }));
};

describe("ContainerFilterBar", () => {
  it("names every control from the catalog", () => {
    renderBar();

    expect(screen.getByLabelText("Search containers")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Status/ })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Origin" })).toBeInTheDocument();
    expect(screen.getByLabelText("Created here")).toBeInTheDocument();
    expect(screen.getByLabelText("Not managed here")).toBeInTheDocument();
  });

  it("keeps the nine states behind the trigger until it is opened", async () => {
    const user = userEvent.setup();
    renderBar();

    // The row is a fixed set of controls. Nine chips in it reflowed the list at every
    // viewport, and eight of the nine are noise to someone looking for the failed one.
    expect(screen.queryByLabelText("Running")).toBeNull();

    const list = await openStatuses(user);
    // Same catalog keys the StatusBadge reads, so an option and a badge cannot disagree.
    expect(
      list.getAllByRole("checkbox").map((box) => box.closest("label")?.textContent),
    ).toEqual([
      "Queued",
      "Building",
      "Deploying",
      "Running",
      "Failed",
      "Sleeping",
      "Removing",
      "Removed",
      "Unknown",
    ]);
  });

  it("reports typing without committing it", async () => {
    const user = userEvent.setup();
    const spies = renderBar();

    await user.type(screen.getByLabelText("Search containers"), "re");

    expect(spies.onDraftChange).toHaveBeenCalled();
    // The debounce lives in the hook; the bar never decides when a query is final.
    expect(spies.onFlushDraft).not.toHaveBeenCalled();
  });

  it("flushes on Enter and clears on Escape", async () => {
    const user = userEvent.setup();
    const spies = renderBar({ draft: "redis" });
    const input = screen.getByLabelText("Search containers");

    await user.type(input, "{Enter}");
    expect(spies.onFlushDraft).toHaveBeenCalledOnce();

    await user.type(input, "{Escape}");
    expect(spies.onDraftChange).toHaveBeenLastCalledWith("");
  });

  it("adds a status to the selection rather than replacing it", async () => {
    const user = userEvent.setup();
    const spies = renderBar({ filters: { ...NO_FILTERS, statuses: ["running"] } });

    const list = await openStatuses(user);
    await user.click(list.getByLabelText("Failed"));

    expect(spies.onStatusesChange).toHaveBeenCalledWith(["running", "failed"]);
  });

  it("removes a status that is unticked", async () => {
    const user = userEvent.setup();
    const spies = renderBar({
      filters: { ...NO_FILTERS, statuses: ["running", "failed"] },
    });

    const list = await openStatuses(user);
    await user.click(list.getByLabelText("Running"));

    expect(spies.onStatusesChange).toHaveBeenCalledWith(["failed"]);
  });

  it("counts the selection on the trigger, in words as well as in a badge", () => {
    renderBar({ filters: { ...NO_FILTERS, statuses: ["running", "failed"] } });

    // A bare numeral read out after the label is a riddle, so the badge is aria-hidden
    // and the same fact is in the accessible name — which still opens with "Status", as
    // Label in Name requires.
    expect(
      screen.getByRole("button", { name: "Status, 2 selected" }),
    ).toBeInTheDocument();
  });

  it("shows the selection as chips, each removing only itself", async () => {
    const user = userEvent.setup();
    const spies = renderBar({
      filters: { ...NO_FILTERS, statuses: ["running", "failed"] },
    });

    const selected = within(screen.getByRole("group", { name: "Selected statuses" }));
    expect(selected.getByText("Running")).toBeInTheDocument();
    expect(selected.getByText("Failed")).toBeInTheDocument();

    await user.click(
      selected.getByRole("button", { name: "Remove the Running filter" }),
    );

    // A count in a trigger cannot do this, which is the whole reason the chips exist.
    expect(spies.onStatusesChange).toHaveBeenCalledWith(["failed"]);
  });

  it("has no chip strip at all when nothing is selected", () => {
    renderBar();
    expect(screen.queryByRole("group", { name: "Selected statuses" })).toBeNull();
  });

  it("keeps owners in the order the URL uses, whichever box is ticked first", async () => {
    const user = userEvent.setup();
    const spies = renderBar({ filters: { ...NO_FILTERS, owners: ["external"] } });

    await user.click(screen.getByLabelText("Created here"));

    // Canonical order, so one selection has one URL and the filter key stays comparable.
    expect(spies.onOwnersChange).toHaveBeenCalledWith(["created", "external"]);
  });

  it("unticks an owner without disturbing the other", async () => {
    const user = userEvent.setup();
    const spies = renderBar({
      filters: { ...NO_FILTERS, owners: ["created", "external"] },
    });

    await user.click(screen.getByLabelText("Created here"));

    expect(spies.onOwnersChange).toHaveBeenCalledWith(["external"]);
  });

  it("keeps Clear mounted and disabled rather than letting it reflow the row", async () => {
    const user = userEvent.setup();
    const spies = renderBar();

    /*
     * Mounting it with the selection was the more considerate-sounding rule and the
     * worse one: the control that appears also reflows the row it appears in, at the
     * exact moment the user is aiming at something else in that row.
     */
    const clear = screen.getByRole("button", { name: "Clear filters" });
    expect(clear).toBeDisabled();
    await user.click(clear);
    expect(spies.onClear).not.toHaveBeenCalled();
  });

  it("clears when there is something to clear", async () => {
    const user = userEvent.setup();
    const spies = renderBar({ canClear: true, draft: "redis" });

    await user.click(screen.getByRole("button", { name: "Clear filters" }));

    expect(spies.onClear).toHaveBeenCalledOnce();
  });

  it("gives every control in the row one height", () => {
    /*
     * The control tokens exist so a field, a dropdown trigger and a button on the same
     * row cannot disagree, and picking a `size` per control is how a row ends up with
     * three heights on it — which is what happened here the moment the status filter
     * stopped being a strip of chips and became a control among controls.
     */
    renderBar({ canClear: true });

    const heights = [
      screen.getByLabelText("Search containers"),
      screen.getByRole("button", { name: /^Status/ }),
      screen.getByRole("button", { name: "Clear filters" }),
    ].map((el) => [...el.classList].find((name) => name.startsWith("h-control-")));

    expect(heights).toEqual(["h-control-md", "h-control-md", "h-control-md"]);
  });

  it("caps the search box at the length the parser keeps", () => {
    renderBar();

    // Otherwise the box shows more than the URL will carry and the list stops matching
    // what the reader typed. The parser is the authority; this mirrors it.
    const capped = parseFilters(new URLSearchParams(`q=${"x".repeat(200)}`)).query;
    expect(screen.getByLabelText("Search containers")).toHaveAttribute(
      "maxlength",
      String(capped.length),
    );
  });
});
