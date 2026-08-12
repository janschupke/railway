import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LogPane } from "./log-pane";
import { LogPaneSkeleton } from "./log-pane-skeleton";

describe("LogPaneSkeleton", () => {
  it("presents the log region before the pane's chunk arrives", () => {
    // The point of matching LogPane's first frame: the region and its name exist from
    // the click, so nothing is swapped out when the real pane lands.
    render(<LogPaneSkeleton />);

    const region = screen.getByRole("log");
    expect(region).toHaveAccessibleName("Container logs");
    expect(region).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Connecting…")).toBeInTheDocument();
  });

  it("occupies exactly the height the real pane will", () => {
    // Two files own this number; a mismatch is a jump at the moment the chunk lands.
    const { unmount } = render(<LogPaneSkeleton />);
    expect(screen.getByRole("log")).toHaveClass("h-64");
    unmount();

    render(<LogPane lines={[]} status="connecting" />);
    // LogPane puts the height on ScrollArea's root, one level above the log viewport.
    expect(screen.getByRole("log").parentElement).toHaveClass("h-64");
  });
});
