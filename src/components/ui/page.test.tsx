import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BarInner, PageMain, SkipLink } from "./page";

/*
 * jsdom applies no Tailwind, so the class list is what can be asserted here. That is
 * enough for the defect these exist for: the header and the footer did not lose their
 * row layout to a CSS bug, they lost it to a variant that was never passed and silently
 * fell back to the page-shaped default.
 */
describe("PageMain", () => {
  it("is the main landmark the skip link targets, and is focusable only as its target", () => {
    render(<PageMain>content</PageMain>);

    const main = screen.getByRole("main");
    expect(main).toHaveAttribute("id", "main");
    // -1, not 0: focus must land here when the fragment is followed, without adding a
    // stop to everyone else's tab sequence.
    expect(main).toHaveAttribute("tabindex", "-1");
  });

  it("is the id the skip link points at", () => {
    // A skip link aimed at an id no page renders reports success to a keyboard user and
    // moves focus nowhere, so the two are asserted against each other rather than each
    // against a string.
    const { container } = render(
      <>
        <SkipLink label="Skip to content" />
        <PageMain />
      </>,
    );

    const target = screen.getByRole("link", { name: "Skip to content" });
    expect(target.getAttribute("href")).toBe(`#${screen.getByRole("main").id}`);
    expect(container.querySelectorAll("#main")).toHaveLength(1);
  });

  it("grows to fill the page, whatever the variants", () => {
    // <body> is a min-height flex column and the footer sits on `mt-auto`; a main region
    // that does not grow puts the footer directly under short content.
    for (const element of [
      <PageMain key="a" />,
      <PageMain key="b" width="narrow" layout="centre" />,
    ]) {
      const { container, unmount } = render(element);
      expect(container.firstElementChild).toHaveClass("flex-1");
      unmount();
    }
  });
});

describe("BarInner", () => {
  it("lays out as a row without being asked", () => {
    /*
     * The regression: BarInner defaulted `pad` but not `layout`, so both callers took
     * `column`'s page-shaped default and rendered `space-y-6` — a vertical stack with no
     * justification, which is what the header and the footer became.
     */
    const { container } = render(<BarInner />);
    const bar = container.firstElementChild;

    expect(bar).toHaveClass("flex", "items-center", "justify-between");
    expect(bar).not.toHaveClass("space-y-6");
    // Bar padding, not page padding.
    expect(bar).toHaveClass("px-6", "py-3");
    expect(bar).not.toHaveClass("p-6");
  });

  it("lines up with the content column", () => {
    // The header, the footer and the dashboard share one max width, or the chrome reads
    // as a separate frame from the content it wraps.
    const { container } = render(<BarInner />);
    expect(container.firstElementChild).toHaveClass("mx-auto", "w-full", "max-w-4xl");
  });

  it("still takes an explicit variant over its default", () => {
    const { container } = render(<BarInner pad="page" />);
    expect(container.firstElementChild).toHaveClass("p-6");
  });
});
