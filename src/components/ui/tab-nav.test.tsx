import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TabNav, type TabItem } from "./tab-nav";

const items: TabItem[] = [
  { href: "/dashboard?project=p1", label: "Containers", current: true },
  { href: "/dashboard/new?project=p1", label: "New container", current: false },
  { href: "/dashboard/billing?project=p1", label: "Billing", current: false },
];

describe("TabNav", () => {
  it("names the navigation landmark, not the list inside it", () => {
    /*
     * Load-bearing. e2e/support.ts locates the container list with
     * getByRole("list", { name: "Containers" }) and asserts exactly one match, so a named
     * list here would break every container spec at once.
     */
    render(<TabNav label="Dashboard sections" items={items} />);

    expect(
      screen.getByRole("navigation", { name: "Dashboard sections" }),
    ).toBeVisible();
    expect(screen.getByRole("list")).not.toHaveAccessibleName();
  });

  it("marks exactly one tab as the current page", () => {
    render(<TabNav label="Dashboard sections" items={items} />);

    const current = screen
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page");

    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAccessibleName("Containers");
  });

  it("renders links rather than tabs, so the browser's own navigation works", () => {
    // The decision this component argues for in its docblock: role=tablist would promise
    // arrow-key focus and an in-document panel, and there is neither.
    render(<TabNav label="Dashboard sections" items={items} />);

    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(3);
  });

  it("passes each href through untouched, query string and all", () => {
    render(<TabNav label="Dashboard sections" items={items} />);

    expect(screen.getByRole("link", { name: "New container" })).toHaveAttribute(
      "href",
      "/dashboard/new?project=p1",
    );
  });

  it("gives the inactive tabs no aria-current at all", () => {
    // `aria-current="false"` is a value assistive tech announces; absent is the only
    // spelling that means "not this one".
    render(<TabNav label="Dashboard sections" items={items} />);

    expect(screen.getByRole("link", { name: "Billing" })).not.toHaveAttribute(
      "aria-current",
    );
  });
});
