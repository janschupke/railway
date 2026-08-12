import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LINKS } from "@/lib/constants";
import { Footer } from "./footer";

describe("Footer", () => {
  it("is a contentinfo landmark, so it is reachable by landmark navigation", async () => {
    render(await Footer());
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
  });

  it("links out to the source and to Railway, safely", async () => {
    render(await Footer());

    const source = screen.getByRole("link", { name: /source on github/i });
    const railway = screen.getByRole("link", { name: /built on railway/i });

    expect(source).toHaveAttribute("href", LINKS.REPOSITORY);
    expect(railway).toHaveAttribute("href", LINKS.RAILWAY_HOME);
    // target=_blank without this hands the new tab a reference back to this one.
    for (const link of [source, railway]) {
      expect(link).toHaveAttribute("rel", "noreferrer");
    }
  });

  it("carries the shared text-link affordance", async () => {
    /*
     * These were distinguished from the caption beside them by colour alone. The rule
     * itself lives in globals.css — jsdom applies no Tailwind, so the class is what can
     * be asserted here, and globals.test.ts checks the rule exists.
     */
    render(await Footer());

    for (const name of [/source on github/i, /built on railway/i]) {
      expect(screen.getByRole("link", { name })).toHaveClass("link");
    }
  });

  it("says the app is not Railway", async () => {
    // The app is styled after Railway and talks to Railway's API from the user's own
    // account; leaving that unstated is the sort of thing a reasonable person misreads.
    render(await Footer());
    expect(screen.getByText(/not affiliated with railway/i)).toBeInTheDocument();
  });
});
