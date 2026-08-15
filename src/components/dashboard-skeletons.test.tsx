import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  BillingSectionSkeleton,
  ContainerSectionSkeleton,
  ProjectPickerSkeleton,
  SpinUpFormSkeleton,
} from "./dashboard-skeletons";

const billing = { spendHeading: "Workspace spend", usageHeading: "Usage" };

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

    // Each row contributes a pill placeholder for the status badge, so this counts rows.
    // Scoped to them regardless of what else is on screen: the bar above the card carried
    // a strip of pills until the status filter became a dropdown, and will again the
    // moment anything else here is drawn as one.
    expect(
      container.querySelectorAll('[data-loading="container-rows"] .rounded-full'),
    ).toHaveLength(5);
    for (const el of container.querySelectorAll(".bg-skeleton")) {
      expect(el).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("stands in for the filter bar the loaded list carries", () => {
    /*
     * Without this the card jumps a control row down the page the moment the fetch lands
     * — the skeleton-versus-real drift this file exists to prevent, now that the real
     * section grows a search field, a status dropdown, two checkboxes and a Clear button
     * above its card.
     *
     * `basis-80` and not merely "a wide thing": the basis is what decides whether the
     * search field shares its line with the status trigger at phone width, so a
     * placeholder at the old 64 would reserve one row where the real bar draws two.
     */
    const { container } = render(<ContainerSectionSkeleton heading="Containers" />);
    expect(container.querySelector(".h-control-md.basis-80")).toBeInTheDocument();
  });

  it("stands in for the time column at the width the row actually uses", () => {
    /*
     * The pair drifted once already: the row's time cell grew to fit "34 minutes ago"
     * without a wrap and the placeholder stayed at the old 80px, so every row settled
     * wider than the skeleton it replaced. Asserted by class because that is the only
     * place the two agree.
     */
    const { container } = render(<ContainerSectionSkeleton heading="Containers" />);
    expect(container.querySelector(".w-24.shrink-0")).toBeInTheDocument();
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
    expect(BillingSectionSkeleton(billing)).not.toBeInstanceOf(Promise);
  });
});

describe("BillingSectionSkeleton", () => {
  it("keeps both headings as real text so neither flickers", () => {
    // Same argument as the container section's: they never depend on the fetch.
    render(<BillingSectionSkeleton {...billing} />);

    expect(
      screen.getByRole("heading", { name: "Workspace spend" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Usage" })).toBeInTheDocument();
  });

  it("renders no list, so the real container list stays uniquely findable", () => {
    render(<BillingSectionSkeleton {...billing} />);
    expect(screen.queryAllByRole("list")).toHaveLength(0);
  });

  it("marks the section busy without claiming a live region", () => {
    const { container } = render(<BillingSectionSkeleton {...billing} />);
    const section = container.querySelector("section");

    expect(section).toHaveAttribute("aria-busy", "true");
    expect(section).not.toHaveAttribute("role");
    expect(section).not.toHaveAttribute("aria-label");
  });

  it("hides every placeholder from assistive tech", () => {
    const { container } = render(<BillingSectionSkeleton {...billing} />);
    for (const el of container.querySelectorAll(".bg-skeleton")) {
      expect(el).toHaveAttribute("aria-hidden", "true");
    }
  });
});
