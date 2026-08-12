import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { describe, expect, it } from "vitest";
import { SignInButton } from "./sign-in-button";
import { SignOutButton } from "./sign-out-button";

describe("SignInButton", () => {
  it("is a plain link until it is used, so it works before hydration", () => {
    render(<SignInButton />);

    const link = screen.getByRole("link", { name: "Sign in with Railway" });
    expect(link).toHaveAttribute("href", "/api/auth/login");
    expect(link).not.toHaveAttribute("aria-busy");
  });

  it("goes busy on click and refuses a second activation", async () => {
    // The original defect: clicking did nothing visible for the whole OAuth round trip,
    // and every extra click started another one.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<SignInButton />);

    const link = screen.getByRole("link");
    await user.click(link);

    expect(link).toHaveAttribute("aria-busy", "true");
    expect(link).toHaveAttribute("aria-disabled", "true");
    expect(link).toHaveTextContent("Redirecting to Railway…");
  });

  it("clears on pageshow, so browser Back does not leave it spinning", async () => {
    /*
     * Declining Railway's consent screen and pressing Back restores this page from
     * bfcache with the DOM exactly as it was left — spinner included.
     */
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<SignInButton />);

    const link = screen.getByRole("link");
    await user.click(link);
    expect(link).toHaveAttribute("aria-busy", "true");

    await act(async () => {
      window.dispatchEvent(new Event("pageshow"));
    });

    expect(link).not.toHaveAttribute("aria-busy");
    expect(link).toHaveTextContent("Sign in with Railway");
  });

  it("takes a label and variant for the empty-project call to action", () => {
    render(<SignInButton label="Choose projects" variant="secondary" size="sm" />);
    expect(screen.getByRole("link", { name: "Choose projects" })).toBeInTheDocument();
  });
});

describe("SignOutButton", () => {
  it("posts to the logout route", () => {
    const { container } = render(<SignOutButton />);

    const form = container.querySelector("form");
    expect(form).toHaveAttribute("action", "/api/auth/logout");
    expect(form).toHaveAttribute("method", "post");
  });

  it("goes busy on submit", async () => {
    const user = userEvent.setup();
    render(<SignOutButton />);

    await user.click(screen.getByRole("button", { name: "Sign out" }));

    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveTextContent("Signing out…");
  });
});
