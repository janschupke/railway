import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppHeader } from "./app-header";

describe("AppHeader", () => {
  it("shows the signed-in name", async () => {
    render(
      await AppHeader({ user: { name: "Ada Lovelace", email: "ada@example.com" } }),
    );
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
  });

  it("falls back to the email when there is no name", async () => {
    render(await AppHeader({ user: { email: "ada@example.com" } }));
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
  });

  it("shows nothing rather than the words 'Signed in'", async () => {
    /*
     * The old fallback filled the identity slot with a label that told the user
     * something the Sign out button beside it already says — and made an account with
     * no profile look like it had one.
     */
    render(await AppHeader({ user: {} }));

    expect(screen.queryByText("Signed in")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument();
  });

  it("offers no way to sign out when nobody is signed in", async () => {
    /*
     * The case that let one bar serve every route. `user: null` is not the same as
     * `user: {}` — the second is a signed-in account with no profile, which still needs
     * the button. Without this distinction the landing page and the 404 would invite an
     * anonymous visitor to sign out of a session they do not have.
     */
    render(await AppHeader({ user: null }));

    expect(screen.queryByRole("button", { name: /sign out/i })).not.toBeInTheDocument();
    // …and the rest of the bar is still there, which is the point of rendering it.
    expect(
      screen.getByRole("radiogroup", { name: "Colour theme" }),
    ).toBeInTheDocument();
  });

  it("takes the brand home from either session state", async () => {
    /*
     * The top-left mark is what a visitor reaches for on the 404 and on the dashboard's
     * error boundary, which are the two screens with nothing else to click. One href
     * serves both states: `/` redirects to the dashboard when a session exists, and the
     * proxy redirects the dashboard back to `/` when one does not.
     */
    for (const user of [null, { name: "Ada Lovelace" }]) {
      const { unmount } = render(await AppHeader({ user }));

      expect(
        screen.getByRole("link", { name: /railway freight loader/i }),
      ).toHaveAttribute("href", "/");

      unmount();
    }
  });

  it("sizes the identity and the sign-out label to the same step", async () => {
    // The reported complaint: these two sit side by side and disagreed, because
    // neither had chosen a size — they had each reached for a different Tailwind step.
    render(await AppHeader({ user: { name: "Ada Lovelace" } }));

    expect(screen.getByText("Ada Lovelace")).toHaveClass("text-body");
    expect(screen.getByRole("button", { name: /sign out/i })).toHaveClass("text-body");
  });
});
