import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ContainerSectionSkeleton,
  ProjectPickerSkeleton,
  SpinUpFormSkeleton,
} from "./dashboard-skeletons";

describe("ContainerSectionSkeleton", () => {
  it("keeps the heading as real text so it does not flicker", () => {
    // The heading never depends on the fetch, so it stays put and stays in the a11y
    // tree while the list loads.
    render(<ContainerSectionSkeleton heading="Containers" />);
    expect(screen.getByRole("heading", { name: "Containers" })).toBeInTheDocument();
  });

  it("marks the section busy without claiming a live region", () => {
    // No role=status and no aria-live: toasts and Banner own that role (ui/misc.tsx).
    const { container } = render(<ContainerSectionSkeleton heading="Containers" />);
    const section = container.querySelector("section");

    expect(section).toHaveAttribute("aria-busy", "true");
    expect(section).not.toHaveAttribute("aria-live");
    expect(section).not.toHaveAttribute("role");
    // A named <section> is a landmark; one that comes and goes per project switch is
    // worse than none.
    expect(section).not.toHaveAttribute("aria-label");
  });

  it("renders no list, so the real container list stays uniquely findable", () => {
    /*
     * e2e/support.ts locates the containers by getByRole("list", { name: "Containers" })
     * and asserts there is exactly one. A placeholder <ul> would be a second one and
     * break every container spec.
     */
    render(<ContainerSectionSkeleton heading="Containers" />);
    expect(screen.queryAllByRole("list")).toHaveLength(0);
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("stands in for as many rows as asked, all decorative", () => {
    const { container } = render(
      <ContainerSectionSkeleton heading="Containers" rows={5} />,
    );

    // Each row contributes a pill placeholder for the status badge.
    expect(container.querySelectorAll(".rounded-full")).toHaveLength(5);
    for (const el of container.querySelectorAll(".bg-skeleton")) {
      expect(el).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("renders synchronously from plain strings", () => {
    /*
     * The guard against making a composition `async` to fetch its own translations. A
     * Suspense fallback that suspends escalates past its own boundary to the route
     * boundary, so a project switch would blank the whole page instead of one section.
     */
    expect(ContainerSectionSkeleton({ heading: "Containers" })).not.toBeInstanceOf(
      Promise,
    );
    expect(ProjectPickerSkeleton()).not.toBeInstanceOf(Promise);
    expect(SpinUpFormSkeleton()).not.toBeInstanceOf(Promise);
  });
});
