/**
 * The palette, memoised, and invalidated when the theme changes underneath it.
 *
 * `getComputedStyle` is a layout read. Doing one per frame would be a style recalculation
 * sixty times a second for values that change when a person clicks a toggle — so it
 * happens once, and again only when one of the two things that can change the answer
 * actually does.
 */

import { resolvePalette, type YardPalette } from "./palette";

/** Just enough of MediaQueryList to be substitutable in a test. */
export type MediaQueryLike = {
  readonly matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
};

export type ThemeDeps = {
  readonly readToken: (token: string) => string;
  readonly matches: (query: string) => MediaQueryLike;
  readonly observeTheme: (onChange: () => void) => () => void;
};

export type ThemeSource = {
  /** The current palette, resolved at most once per invalidation. */
  palette(): YardPalette | null;
  /** True once since the last call. Lets the loop rebuild the static layer exactly once. */
  takeDirty(): boolean;
  dispose(): void;
};

/** The query the OS answers. Watched because a token's value differs per theme. */
const COLOUR_SCHEME = "(prefers-color-scheme: light)";

export function createThemeSource(
  deps: ThemeDeps,
  onInvalidate?: () => void,
): ThemeSource {
  let cached: YardPalette | null = null;
  let resolved = false;
  let dirty = true;

  const invalidate = () => {
    resolved = false;
    dirty = true;
    onInvalidate?.();
  };

  /*
   * Two paths, and both are needed. The theme toggle writes `data-theme` on <html>, which
   * no media query reports; the OS preference moves the media query without touching the
   * attribute. Watching one of them covers half the users.
   */
  const stopObserving = deps.observeTheme(invalidate);
  const scheme = deps.matches(COLOUR_SCHEME);
  scheme.addEventListener("change", invalidate);

  return {
    palette() {
      if (!resolved) {
        cached = resolvePalette(deps.readToken);
        resolved = true;
      }
      return cached;
    },
    takeDirty() {
      const was = dirty;
      dirty = false;
      return was;
    },
    dispose() {
      stopObserving();
      scheme.removeEventListener("change", invalidate);
    },
  };
}
