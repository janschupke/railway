import { describe, expect, it, vi } from "vitest";
import { RAIL_YARD_TOKENS } from "./palette";
import { createThemeSource, type MediaQueryLike, type ThemeDeps } from "./theme-source";

/** A media query whose listeners a test can fire. */
function fakeQuery(matches = false) {
  const listeners = new Set<() => void>();
  const query: MediaQueryLike = {
    matches,
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  return { query, fire: () => listeners.forEach((listener) => listener()) };
}

function harness(overrides: Partial<ThemeDeps> = {}) {
  let colour = "#111111";
  const scheme = fakeQuery();
  let themeListener: (() => void) | null = null;
  // Actually detaches, rather than only recording that it was asked to: a stub that
  // keeps firing after dispose cannot tell a released subscription from a leaked one.
  const stopObserving = vi.fn(() => {
    themeListener = null;
  });
  const readToken = vi.fn(() => colour);

  const deps: ThemeDeps = {
    readToken,
    matches: () => scheme.query,
    observeTheme: (onChange) => {
      themeListener = onChange;
      return stopObserving;
    },
    ...overrides,
  };

  return {
    deps,
    readToken,
    stopObserving,
    fireScheme: scheme.fire,
    fireTheme: () => themeListener?.(),
    setColour: (next: string) => {
      colour = next;
    },
  };
}

describe("createThemeSource", () => {
  it("resolves once and memoises after that", () => {
    // getComputedStyle is a style recalculation. Doing one per frame for a value that
    // changes when someone clicks a toggle is sixty a second for nothing.
    const { deps, readToken } = harness();
    const source = createThemeSource(deps);

    source.palette();
    source.palette();
    source.palette();

    expect(readToken).toHaveBeenCalledTimes(Object.keys(RAIL_YARD_TOKENS).length + 6);
  });

  it("re-resolves when the theme attribute changes", () => {
    const { deps, setColour, fireTheme } = harness();
    const source = createThemeSource(deps);
    expect(source.palette()?.ground).toBe("#111111");

    setColour("#222222");
    // Still memoised: nothing has told it otherwise.
    expect(source.palette()?.ground).toBe("#111111");

    fireTheme();
    expect(source.palette()?.ground).toBe("#222222");
  });

  it("re-resolves when the OS colour scheme changes", () => {
    // Two paths, and both are needed: the toggle writes an attribute no media query
    // reports, and the OS preference moves a query that touches no attribute.
    const { deps, setColour, fireScheme } = harness();
    const source = createThemeSource(deps);
    source.palette();

    setColour("#333333");
    fireScheme();
    expect(source.palette()?.ground).toBe("#333333");
  });

  it("reports dirty once per invalidation", () => {
    const { deps, fireTheme } = harness();
    const source = createThemeSource(deps);

    // Dirty on creation: the static layer has never been composed.
    expect(source.takeDirty()).toBe(true);
    expect(source.takeDirty()).toBe(false);

    fireTheme();
    expect(source.takeDirty()).toBe(true);
    expect(source.takeDirty()).toBe(false);
  });

  it("tells its owner when the palette went stale", () => {
    const onInvalidate = vi.fn();
    const { deps, fireTheme, fireScheme } = harness();
    createThemeSource(deps, onInvalidate);

    fireTheme();
    fireScheme();
    expect(onInvalidate).toHaveBeenCalledTimes(2);
  });

  it("returns nothing when the token layer does not answer", () => {
    const { deps } = harness({ readToken: () => "" });
    expect(createThemeSource(deps).palette()).toBeNull();
  });

  it("releases both subscriptions on dispose", () => {
    const { deps, stopObserving, fireTheme } = harness();
    const onInvalidate = vi.fn();
    const source = createThemeSource(deps, onInvalidate);

    source.dispose();
    expect(stopObserving).toHaveBeenCalled();

    // The mutation observer is gone, so nothing should reach the callback any more.
    fireTheme();
    expect(onInvalidate).not.toHaveBeenCalled();
  });
});
