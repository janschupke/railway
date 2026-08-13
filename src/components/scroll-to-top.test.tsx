import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIST } from "@/lib/constants";
import { CONTAINER_HEADING_ID } from "./container-section-header";
import { ScrollToTop } from "./scroll-to-top";

/** The component coalesces scroll reads into a frame, so the assertion waits for one. */
const scrollTo = async (y: number) => {
  Object.defineProperty(window, "scrollY", { value: y, configurable: true });
  await act(async () => {
    window.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
};

const reduceMotion = (matches: boolean) =>
  vi.spyOn(window, "matchMedia").mockReturnValue({
    matches,
    media: "(prefers-reduced-motion: reduce)",
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as MediaQueryList);

const button = () => screen.queryByRole("button", { name: "Back to top" });

afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(window.scrollTo).mockClear();
  await scrollTo(0);
});

describe("ScrollToTop", () => {
  it("stays out of the way until the page is actually long", async () => {
    render(<ScrollToTop />);
    expect(button()).toBeNull();

    await scrollTo(LIST.SCROLL_TOP_AFTER_PX + 1);
    expect(button()).toBeInTheDocument();
  });

  it("goes away again on the way back up", async () => {
    render(<ScrollToTop />);
    await scrollTo(LIST.SCROLL_TOP_AFTER_PX + 1);
    await scrollTo(0);
    expect(button()).toBeNull();
  });

  it("scrolls smoothly by default", async () => {
    const user = userEvent.setup();
    reduceMotion(false);
    render(<ScrollToTop />);
    await scrollTo(LIST.SCROLL_TOP_AFTER_PX + 1);

    await user.click(button()!);

    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  });

  it("jumps instead when motion is reduced", async () => {
    /*
     * globals.css neutralises animations and transitions globally, but scrollTo's
     * behavior is a JS argument that overrides the CSS property — so this is the one
     * motion on the page the global rule cannot reach.
     */
    const user = userEvent.setup();
    reduceMotion(true);
    render(<ScrollToTop />);
    await scrollTo(LIST.SCROLL_TOP_AFTER_PX + 1);

    await user.click(button()!);

    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" });
  });

  it("hands focus to the heading it scrolled to", async () => {
    const user = userEvent.setup();
    reduceMotion(false);
    const heading = document.createElement("h2");
    heading.id = CONTAINER_HEADING_ID;
    heading.tabIndex = -1;
    document.body.append(heading);

    render(<ScrollToTop />);
    await scrollTo(LIST.SCROLL_TOP_AFTER_PX + 1);
    await user.click(button()!);

    // Otherwise focus is stranded on a control that is now off screen.
    expect(document.activeElement).toBe(heading);
    heading.remove();
  });
});
