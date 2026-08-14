import { describe, expect, it } from "vitest";
import { isManagedName, stripPrefix, toManagedName } from "./managed";

// MANAGED_PREFIX is "spun-" in src/test/setup.ts.

describe("toManagedName", () => {
  it("slugifies and prefixes", () => {
    expect(toManagedName("My Redis!")).toBe("spun-my-redis");
  });

  it("collapses runs of separators and trims them", () => {
    expect(toManagedName("  a   b--c  ")).toBe("spun-a-b-c");
  });

  it("falls back when the input slugifies to nothing", () => {
    expect(toManagedName("!!!")).toBe("spun-container");
  });

  it("bounds the slug length", () => {
    const name = toManagedName("x".repeat(100));
    expect(name.length).toBe("spun-".length + 32);
  });
});

describe("ownership", () => {
  it("recognises names this app created", () => {
    expect(isManagedName("spun-cache")).toBe(true);
  });

  it("does not claim services created elsewhere", () => {
    // The guard that stops the app from deleting a user's real infrastructure.
    expect(isManagedName("postgres")).toBe(false);
    expect(isManagedName("my-spun-thing")).toBe(false);
  });

  it("claims any prefixed name, whoever created it", () => {
    /*
     * The documented limit of the marker, pinned so it cannot be "fixed" quietly.
     *
     * The prefix is cosmetic: a service renamed to `spun-…` in Railway's own dashboard
     * is indistinguishable from one this app created, and becomes destroyable here.
     * ADR-5 accepts that — the blast radius is bounded by the scopes the user granted,
     * and the marker is visible in Railway's UI rather than hidden in metadata. What
     * would not be acceptable is the copy or a future reader believing otherwise.
     */
    expect(isManagedName("spun-someone-elses-database")).toBe(true);
  });

  it("strips the prefix for display, and leaves unmanaged names alone", () => {
    expect(stripPrefix("spun-cache")).toBe("cache");
    expect(stripPrefix("postgres")).toBe("postgres");
  });
});

describe("renaming", () => {
  /*
   * The rename safety property, which is a property of `toManagedName` rather than of any
   * rule written next to it.
   *
   * Since T-489 the name is something a user edits, and the name is the ownership marker —
   * so a rename that dropped the prefix would leave a container this app created and can no
   * longer destroy. There is no validation rule refusing such a name, and there should not
   * be one: `toManagedName` always prefixes, so the unmanaged name is not a value the edit
   * path can produce. This is what says so.
   */
  it.each([
    "cache",
    "../../escape",
    "spun-",
    "!!!",
    "x".repeat(200),
    "  ",
    "UPPER CASE",
  ])("produces a managed name for %j", (input) => {
    expect(isManagedName(toManagedName(input))).toBe(true);
  });

  it("re-prefixes the display name, which is what the edit form posts back", () => {
    /*
     * The direction this runs in, pinned because getting it backwards is silent. The row
     * shows `stripPrefix(rawName)` and the form posts that, so `toManagedName` is what puts
     * the prefix back — and handing it `rawName` instead would prefix a second time.
     */
    expect(toManagedName(stripPrefix("spun-cache"))).toBe("spun-cache");
    expect(toManagedName("spun-cache")).toBe("spun-spun-cache");
  });
});
