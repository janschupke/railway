import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DashboardHeader } from "./dashboard-header";

describe("DashboardHeader", () => {
  it("shows the signed-in name", async () => {
    render(await DashboardHeader({ name: "Ada Lovelace", email: "ada@example.com" }));
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
  });

  it("falls back to the email when there is no name", async () => {
    render(await DashboardHeader({ email: "ada@example.com" }));
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
  });

  it("shows nothing rather than the words 'Signed in'", async () => {
    /*
     * The old fallback filled the identity slot with a label that told the user
     * something the Sign out button beside it already says — and made an account with
     * no profile look like it had one.
     */
    render(await DashboardHeader({}));

    expect(screen.queryByText("Signed in")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument();
  });

  it("sizes the identity and the sign-out label to the same step", async () => {
    // The reported complaint: these two sit side by side and disagreed, because
    // neither had chosen a size — they had each reached for a different Tailwind step.
    render(await DashboardHeader({ name: "Ada Lovelace" }));

    expect(screen.getByText("Ada Lovelace")).toHaveClass("text-caption");
    expect(screen.getByRole("button", { name: /sign out/i })).toHaveClass(
      "text-caption",
    );
  });
});
