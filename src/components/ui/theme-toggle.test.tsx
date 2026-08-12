import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { ThemeToggle } from "./theme-toggle";

beforeEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

const option = (name: string) => screen.getByRole("radio", { name });

describe("ThemeToggle", () => {
  it("starts on System when nothing is stored", () => {
    render(<ThemeToggle />);
    expect(option("System")).toHaveAttribute("data-state", "on");
  });

  it("reflects a stored choice on first render, not one render late", () => {
    // useSyncExternalStore reads localStorage during render; an effect would flash.
    window.localStorage.setItem("theme", "light");
    render(<ThemeToggle />);
    expect(option("Light")).toHaveAttribute("data-state", "on");
  });

  it("ignores a corrupt stored value", () => {
    window.localStorage.setItem("theme", "neon");
    render(<ThemeToggle />);
    expect(option("System")).toHaveAttribute("data-state", "on");
  });

  it("writes the override to the document and to storage", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await user.click(option("Light"));

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(window.localStorage.getItem("theme")).toBe("light");
    expect(option("Light")).toHaveAttribute("data-state", "on");
  });

  it("removes the override for System, so the OS preference applies again", async () => {
    // Freezing whatever the OS happened to be at the time would be the wrong thing.
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await user.click(option("Dark"));
    expect(document.documentElement.dataset.theme).toBe("dark");

    await user.click(option("System"));
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(window.localStorage.getItem("theme")).toBeNull();
  });

  it("labels the group and each option for screen readers", () => {
    render(<ThemeToggle />);
    expect(
      screen.getByRole("radiogroup", { name: "Colour theme" }),
    ).toBeInTheDocument();
    for (const name of ["Light", "Dark", "System"]) {
      expect(option(name)).toBeInTheDocument();
    }
  });

  it("keeps two mounted toggles in sync", async () => {
    // The `storage` event only fires in other tabs, so same-tab writes are broadcast
    // explicitly; without that a header toggle and a page toggle would disagree.
    const user = userEvent.setup();
    render(
      <>
        <div data-testid="a">
          <ThemeToggle />
        </div>
        <div data-testid="b">
          <ThemeToggle />
        </div>
      </>,
    );

    const [firstDark] = screen.getAllByRole("radio", { name: "Dark" });
    await user.click(firstDark!);

    for (const dark of screen.getAllByRole("radio", { name: "Dark" })) {
      expect(dark).toHaveAttribute("data-state", "on");
    }
  });
});
