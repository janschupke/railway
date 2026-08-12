import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { routerMock } from "@/test/setup-dom";
import { RefreshButton } from "./refresh-button";

describe("RefreshButton", () => {
  beforeEach(() => routerMock.refresh.mockClear());

  it("re-runs the server render", async () => {
    // The dashboard is force-dynamic, so this is a real second read of Railway — which
    // is what makes it the honest primary action for an empty project list.
    const user = userEvent.setup();
    render(<RefreshButton label="Check again" pendingLabel="Checking…" />);

    await user.click(screen.getByRole("button", { name: "Check again" }));

    expect(routerMock.refresh).toHaveBeenCalledTimes(1);
  });

  it("passes the button's own variants through", async () => {
    render(<RefreshButton label="Check again" pendingLabel="Checking…" size="sm" />);
    expect(screen.getByRole("button")).toHaveClass("text-caption");
  });
});
