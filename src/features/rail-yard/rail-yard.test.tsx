import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RailYard } from "./rail-yard";

/**
 * The component is five lines, and the assertions are about what it must never grow.
 *
 * It renders with no injection at all: jsdom's getContext("2d") returns null, so the hook
 * takes its own early exit and nothing here is mocked. That the real component mounts
 * cleanly in an environment with no canvas is itself the claim.
 */
describe("RailYard", () => {
  it("renders one canvas and nothing else", () => {
    const { container } = render(<RailYard />);
    expect(container.querySelectorAll("canvas")).toHaveLength(1);
    expect(container.firstElementChild?.tagName).toBe("CANVAS");
  });

  it("stays out of the accessibility tree", () => {
    /*
     * The page's meaning is entirely in the card in front of this. A role="img" with a
     * translated description would put a wordless animation into the tree and hand a
     * screen-reader user a sentence to skip past on every visit.
     */
    const { container } = render(<RailYard />);
    const canvas = container.querySelector("canvas")!;
    expect(canvas.getAttribute("aria-hidden")).toBe("true");
    expect(canvas.hasAttribute("role")).toBe(false);
    expect(canvas.hasAttribute("aria-label")).toBe(false);
    expect(screen.queryAllByRole("img")).toHaveLength(0);
  });

  it("stays out of the tab order", () => {
    // The one way this breaks later: a `tabindex` on an aria-hidden element is an
    // aria-hidden-focus violation, and it would fail the axe scan rather than this.
    const canvas = render(<RailYard />).container.querySelector("canvas")!;
    expect(canvas.hasAttribute("tabindex")).toBe(false);
  });

  it("stays out of layout", () => {
    /*
     * Load-bearing rather than cosmetic: absolute positioning keeps the canvas's
     * intrinsic 300x150 out of the flow, so resizing the bitmap can never move anything
     * and a full-page animation on the landing route contributes nothing to layout shift.
     */
    const canvas = render(<RailYard />).container.querySelector("canvas")!;
    expect(canvas.className).toContain("absolute");
    expect(canvas.className).toContain("inset-0");
    expect(canvas.className).toContain("pointer-events-none");
  });

  it("merges a caller's classes rather than dropping its own", () => {
    const canvas = render(<RailYard className="opacity-50" />).container.querySelector(
      "canvas",
    )!;
    expect(canvas.className).toContain("opacity-50");
    expect(canvas.className).toContain("absolute");
  });
});
