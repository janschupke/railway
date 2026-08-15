import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LogPane } from "./log-pane";
import { LogPaneSkeleton } from "./log-pane-skeleton";
import { ToastProvider } from "./ui/toast";
import { TooltipProvider } from "./ui/tooltip";

const toolbar = () => document.querySelector("[data-log-toolbar]");

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
    expect(screen.getByRole("log")).toHaveClass("h-pane-log");
    unmount();

    render(
      // Both providers, as the dashboard layout supplies them: the pane's toolbar names
      // every icon button with a tooltip, and a bare Tooltip is a Radix error.
      <TooltipProvider>
        <ToastProvider>
          <LogPane lines={[]} status="connecting" label="cache" />
        </ToastProvider>
      </TooltipProvider>,
    );
    // LogPane puts the height on ScrollArea's root, one level above the log viewport.
    expect(screen.getByRole("log").parentElement).toHaveClass("h-pane-log");
  });

  it("reserves the toolbar row the real pane occupies", () => {
    /*
     * The placeholder is hand-written rather than the toolbar itself, because importing
     * that here would pull it out of the pane's dynamic chunk and into /dashboard's first
     * load. Which means two files own the height, and only this keeps them together.
     */
    const { unmount } = render(<LogPaneSkeleton />);
    expect(toolbar()).toHaveClass("h-control-md", "mb-2");
    unmount();

    render(
      // Both providers, as the dashboard layout supplies them: the pane's toolbar names
      // every icon button with a tooltip, and a bare Tooltip is a Radix error.
      <TooltipProvider>
        <ToastProvider>
          <LogPane lines={[]} status="connecting" label="cache" />
        </ToastProvider>
      </TooltipProvider>,
    );
    const real = screen.getByRole("group", { name: "Log controls" });
    expect(real).toHaveClass("mb-2");
    // One control row: the search field sets the height, and everything beside it is a
    // small button centred against it. A second row would break the parity above.
    expect(real.querySelector(".h-control-md")).toBeInTheDocument();
  });
});
