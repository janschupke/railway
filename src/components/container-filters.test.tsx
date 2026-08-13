import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NO_FILTERS, parseFilters } from "@/lib/container-filters";
import { ContainerFilterBar } from "./container-filters";

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
      showClear={false}
      {...spies}
      {...over}
    />,
  );
  return spies;
};

describe("ContainerFilterBar", () => {
  it("names every control from the catalog", () => {
    renderBar();

    expect(screen.getByLabelText("Search containers")).toBeInTheDocument();
    // Radix gives a multiple toggle group role=toolbar, which is what carries the roving
    // tabindex: one Tab stop for nine chips, walked with the arrow keys.
    expect(screen.getByRole("toolbar", { name: "Status" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Origin" })).toBeInTheDocument();
    expect(screen.getByLabelText("Created here")).toBeInTheDocument();
    expect(screen.getByLabelText("Not managed here")).toBeInTheDocument();
  });

  it("offers one chip per container state, using the badge's own labels", () => {
    renderBar();

    const chips = screen.getAllByRole("button", { pressed: false });
    // Same catalog keys the StatusBadge reads, so a chip and a badge cannot disagree.
    expect(chips.map((c) => c.textContent)).toEqual([
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

    await user.click(screen.getByRole("button", { name: "Failed" }));

    expect(spies.onStatusesChange).toHaveBeenCalledWith(["running", "failed"]);
  });

  it("removes a status that is toggled off", async () => {
    const user = userEvent.setup();
    const spies = renderBar({
      filters: { ...NO_FILTERS, statuses: ["running", "failed"] },
    });

    await user.click(screen.getByRole("button", { name: "Running", pressed: true }));

    expect(spies.onStatusesChange).toHaveBeenCalledWith(["failed"]);
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

  it("offers Clear only when there is something to clear", async () => {
    const user = userEvent.setup();
    renderBar();
    // A permanently dead control in a filter bar reads as broken, not as inactive.
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();

    const spies = renderBar({ showClear: true, draft: "redis" });
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(spies.onClear).toHaveBeenCalledOnce();
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
