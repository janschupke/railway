import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CONTAINER_STATES } from "@/lib/railway/types";
import { StatusBadge } from "./status-badge";

describe("StatusBadge", () => {
  it("renders a human label, not the raw enum", () => {
    render(<StatusBadge state="running" rawStatus="SUCCESS" />);
    expect(screen.getByText("Running")).toBeInTheDocument();
  });

  it("exposes the raw Railway status to assistive technology", () => {
    // Previously a `title` attribute, which keyboard and screen-reader users
    // never encounter. Anyone debugging against Railway needs the real enum.
    render(<StatusBadge state="failed" rawStatus="CRASHED" />);
    expect(screen.getByText(/Railway status: CRASHED/)).toBeInTheDocument();
  });

  it("omits the redundant announcement when the raw status adds nothing", () => {
    render(<StatusBadge state="running" rawStatus={null} />);
    expect(screen.queryByText(/Railway status/)).not.toBeInTheDocument();
  });

  it("drives colour from a data attribute rather than class strings", () => {
    // The contract globals.css depends on: change this and theming silently breaks.
    const { container } = render(<StatusBadge state="building" />);
    expect(container.querySelector("[data-state-color='building']")).not.toBeNull();
  });

  it("animates only while work is in flight", () => {
    const { container: moving } = render(<StatusBadge state="deploying" />);
    expect(moving.querySelector(".animate-pulse-dot")).not.toBeNull();

    const { container: settled } = render(<StatusBadge state="running" />);
    expect(settled.querySelector(".animate-pulse-dot")).toBeNull();
  });

  it("renders every state without throwing", () => {
    // Railway can add enum members; an unmapped one must degrade, not crash.
    for (const state of CONTAINER_STATES) {
      const { unmount } = render(<StatusBadge state={state} />);
      unmount();
    }
  });
});
