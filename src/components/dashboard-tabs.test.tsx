import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { setPathname, setSearchParams } from "@/test/setup-dom";
import { DashboardTabs } from "./dashboard-tabs";

const href = (name: string) => screen.getByRole("link", { name }).getAttribute("href");

describe("DashboardTabs", () => {
  it("carries the whole query string onto every tab", () => {
    /*
     * The selection AND the list's own filters. The pages deliberately read only
     * {project, environment} from searchParams, so this client-side read is the only
     * thing that stops a tab switch resetting someone's search.
     */
    setSearchParams("project=p1&environment=e1&q=redis");

    render(<DashboardTabs />);

    expect(href("Containers")).toBe("/dashboard?project=p1&environment=e1&q=redis");
    expect(href("New container")).toBe(
      "/dashboard/new?project=p1&environment=e1&q=redis",
    );
    expect(href("Billing")).toBe(
      "/dashboard/billing?project=p1&environment=e1&q=redis",
    );
  });

  it("leaves off the question mark when there is nothing to carry", () => {
    setSearchParams("");

    render(<DashboardTabs />);

    expect(href("Containers")).toBe("/dashboard");
  });

  it("marks the container tab current only on its own route", () => {
    setPathname("/dashboard");
    render(<DashboardTabs />);

    expect(screen.getByRole("link", { name: "Containers" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("does not mark the container tab current on a nested route", () => {
    /*
     * The prefix bug. `/dashboard` is a prefix of both other paths, so a startsWith test
     * would light two tabs at once — and would still pass a test that only ever visited
     * the index.
     */
    setPathname("/dashboard/new");
    render(<DashboardTabs />);

    expect(screen.getByRole("link", { name: "Containers" })).not.toHaveAttribute(
      "aria-current",
    );
    expect(screen.getByRole("link", { name: "New container" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("marks the billing tab current on its route", () => {
    setPathname("/dashboard/billing");
    render(<DashboardTabs />);

    expect(screen.getByRole("link", { name: "Billing" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});
