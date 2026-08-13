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
