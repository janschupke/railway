import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * WCAG AA contrast, asserted against the token file itself.
 *
 * The design system promises a dark *and* a light theme. Those are two independent
 * sets of values, so a change that is legible in one can be unreadable in the other,
 * and nobody notices until a reviewer opens the page on the wrong OS setting.
 *
 * The Playwright axe scans catch this too, but only for colours that happen to be on
 * screen in the states the suite visits, and only after a browser has started. This
 * runs in milliseconds and covers every declared pair.
 */

const TOKENS = readFileSync(path.join(import.meta.dirname, "tokens.css"), "utf8");

const AA_NORMAL = 4.5;
/** Large text and non-text UI boundaries (WCAG 1.4.11). */
const AA_LARGE = 3;
/** Not WCAG: the floor at which a frozen, textless placeholder still reads as a shape. */
const AA_PLACEHOLDER = 1.4;

type Rgb = [number, number, number];

/**
 * Strips @media blocks before parsing.
 *
 * The `prefers-color-scheme: light` block contains its own nested `:root { … }`, which
 * a naive scan folds into the base declarations and silently makes both themes
 * identical. Those values are duplicated by the explicit `[data-theme]` overrides,
 * which is what the app's own cascade relies on, so dropping them here loses nothing.
 */
function stripMediaBlocks(css: string): string {
  let out = "";
  let index = 0;
  for (;;) {
    const start = css.indexOf("@media", index);
    if (start === -1) {
      out += css.slice(index);
      return out;
    }
    out += css.slice(index, start);

    let depth = 0;
    let cursor = css.indexOf("{", start);
    if (cursor === -1) return out;
    for (; cursor < css.length; cursor++) {
      if (css[cursor] === "{") depth += 1;
      else if (css[cursor] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    index = cursor + 1;
  }
}

// Comments sit between rules and would otherwise be captured as part of the selector.
const FLAT = stripMediaBlocks(TOKENS.replace(/\/\*[\s\S]*?\*\//g, ""));

function declarationsOf(body: string): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const line of body.split(";")) {
    const [name, ...rest] = line.split(":");
    if (!name || rest.length === 0) continue;
    const key = name.trim();
    if (!key.startsWith("--")) continue;
    declarations.set(key, rest.join(":").trim());
  }
  return declarations;
}

/** `selector` is matched exactly against the rule's selector text. */
function block(selector: string): Map<string, string> {
  const merged = new Map<string, string>();
  for (const match of FLAT.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[1]!.trim() !== selector) continue;
    for (const [key, value] of declarationsOf(match[2]!)) merged.set(key, value);
  }
  return merged;
}

const PRIMITIVES = block(":root");
const DARK = new Map([...PRIMITIVES, ...block(':root[data-theme="dark"]')]);
const LIGHT = new Map([...PRIMITIVES, ...block(':root[data-theme="light"]')]);

function hexToRgb(hex: string): Rgb {
  const value = hex.replace("#", "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/** Resolves a token to RGB, following var() chains and compositing rgb(... / alpha). */
function resolve(token: string, theme: Map<string, string>, over: Rgb): Rgb {
  let value = theme.get(token);
  let guard = 0;
  while (value?.startsWith("var(") && guard++ < 10) {
    const inner = /var\(\s*(--[\w-]+)\s*\)/.exec(value)?.[1];
    if (!inner) break;
    value = theme.get(inner);
  }
  if (!value) throw new Error(`unresolved token: ${token}`);

  if (value.startsWith("#")) return hexToRgb(value);

  const rgba = /rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\d.]+)\s*\)/.exec(value);
  if (rgba) {
    const [, r, g, b, a] = rgba;
    const alpha = Number(a);
    // Composite the translucent fill over its backdrop — this is what the eye sees.
    return [
      Number(r) * alpha + over[0] * (1 - alpha),
      Number(g) * alpha + over[1] * (1 - alpha),
      Number(b) * alpha + over[2] * (1 - alpha),
    ];
  }

  throw new Error(`unsupported colour format for ${token}: ${value}`);
}

function luminance([r, g, b]: Rgb): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
}

const THEMES = [
  ["dark", DARK],
  ["light", LIGHT],
] as const;

/** Text tokens that must be readable on each surface. */
const TEXT_ON_SURFACE: Array<[fg: string, bg: string]> = [
  ["--rc-text", "--rc-canvas"],
  ["--rc-text", "--rc-surface"],
  ["--rc-text", "--rc-raised"],
  ["--rc-text-muted", "--rc-canvas"],
  ["--rc-text-muted", "--rc-surface"],
  ["--rc-text-subtle", "--rc-canvas"],
  ["--rc-text-subtle", "--rc-surface"],
];

const STATES = [
  "pending",
  "building",
  "deploying",
  "running",
  "failed",
  "sleeping",
  "removing",
  "removed",
  "unknown",
];

const SIGNALS = ["danger", "success", "warning", "info"];

describe.each(THEMES)("%s theme", (themeName, theme) => {
  const surface = (token: string) => resolve(token, theme, [0, 0, 0]);

  it.each(TEXT_ON_SURFACE)("%s on %s meets AA for body text", (fg, bg) => {
    const background = surface(bg);
    const ratio = contrast(resolve(fg, theme, background), background);
    expect(
      Number(ratio.toFixed(2)),
      `${fg} on ${bg} in ${themeName}`,
    ).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it.each(STATES)("the %s status badge is readable on its own fill", (state) => {
    // The badge fill is translucent, so it composites over the card surface.
    const cardSurface = surface("--rc-surface");
    const badgeFill = resolve(`--rc-state-${state}-bg`, theme, cardSurface);
    const label = resolve(`--rc-state-${state}`, theme, badgeFill);

    const ratio = contrast(label, badgeFill);
    expect(
      Number(ratio.toFixed(2)),
      `state ${state} in ${themeName}`,
    ).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it.each(SIGNALS)("the %s banner is readable on its own fill", (signal) => {
    const canvas = surface("--rc-canvas");
    const fill = resolve(`--rc-${signal}-bg`, theme, canvas);
    const text = resolve(`--rc-${signal}`, theme, fill);

    expect(
      Number(contrast(text, fill).toFixed(2)),
      `${signal} banner in ${themeName}`,
    ).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it("the primary button's label is readable on its fill", () => {
    const accent = surface("--rc-accent");
    const label = resolve("--rc-accent-fg", theme, accent);
    expect(Number(contrast(label, accent).toFixed(2))).toBeGreaterThanOrEqual(
      AA_NORMAL,
    );
  });

  it("accent text is readable on the accent fill", () => {
    // The selected preset chip: accent text on a translucent accent wash.
    const cardSurface = surface("--rc-surface");
    const fill = resolve("--rc-accent-bg", theme, cardSurface);
    const text = resolve("--rc-accent", theme, fill);
    expect(
      Number(contrast(text, fill).toFixed(2)),
      `accent chip in ${themeName}`,
    ).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it.each(SIGNALS)("%s text is readable directly on a card", (signal) => {
    // Outline buttons (Destroy) put signal-coloured text straight onto the surface.
    const cardSurface = surface("--rc-surface");
    const text = resolve(`--rc-${signal}`, theme, cardSurface);
    expect(
      Number(contrast(text, cardSurface).toFixed(2)),
      `${signal} on surface in ${themeName}`,
    ).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it.each(SIGNALS)("%s text is readable on the raised surface", (signal) => {
    // Dialogs sit on --rc-raised, which is a different colour from the card.
    const raised = surface("--rc-raised");
    const text = resolve(`--rc-${signal}`, theme, raised);
    expect(
      Number(contrast(text, raised).toFixed(2)),
      `${signal} on raised in ${themeName}`,
    ).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it("the focus ring is distinguishable from the surfaces it sits on", () => {
    // 1.4.11: a focus indicator is a non-text UI component, so 3:1.
    for (const bg of ["--rc-canvas", "--rc-surface", "--rc-raised"]) {
      const background = surface(bg);
      const ring = resolve("--rc-accent", theme, background);
      expect(
        Number(contrast(ring, background).toFixed(2)),
        `focus ring on ${bg} in ${themeName}`,
      ).toBeGreaterThanOrEqual(AA_LARGE);
    }
  });

  it("the skeleton fill is visible on the surfaces it sits on", () => {
    /*
     * Not a WCAG threshold — a placeholder is decorative and carries no text. This is
     * the "still reads as a shape once the pulse is frozen" floor, which is the state
     * every prefers-reduced-motion user sees (globals.css kills the animation).
     */
    for (const bg of ["--rc-canvas", "--rc-surface"]) {
      const background = surface(bg);
      const fill = resolve("--rc-skeleton", theme, background);
      expect(
        Number(contrast(fill, background).toFixed(2)),
        `skeleton on ${bg} in ${themeName}`,
      ).toBeGreaterThanOrEqual(AA_PLACEHOLDER);
    }
  });

  it("borders are visible against their surfaces", () => {
    const surfaceRgb = surface("--rc-surface");
    expect(
      Number(
        contrast(resolve("--rc-border", theme, surfaceRgb), surfaceRgb).toFixed(2),
      ),
    ).toBeGreaterThanOrEqual(1.2);
  });
});

describe("token parsing", () => {
  it("found both theme blocks", () => {
    // A silent parse failure would make every assertion above vacuous.
    expect(DARK.get("--rc-canvas")).toBeDefined();
    expect(LIGHT.get("--rc-canvas")).toBeDefined();
    expect(DARK.get("--rc-canvas")).not.toBe(LIGHT.get("--rc-canvas"));
  });

  it("defines the skeleton fill in both themes", () => {
    for (const [name, theme] of THEMES) {
      expect(theme.get("--rc-skeleton"), `skeleton in ${name}`).toBeDefined();
    }
    expect(DARK.get("--rc-skeleton")).not.toBe(LIGHT.get("--rc-skeleton"));
  });

  it("defines every container state in both themes", () => {
    for (const [name, theme] of THEMES) {
      for (const state of STATES) {
        expect(theme.get(`--rc-state-${state}`), `${state} in ${name}`).toBeDefined();
        expect(
          theme.get(`--rc-state-${state}-bg`),
          `${state}-bg in ${name}`,
        ).toBeDefined();
      }
    }
  });
});

/**
 * Every themed token exists in every theme.
 *
 * accessibility.md and design-system.md both say a new colour token must be declared in
 * dark, in light AND in the prefers-color-scheme block. Nothing checked it, and the
 * failure is quiet in the worst way: a token missing from one theme inherits whatever
 * the base `:root` happens to hold, so the app does not crash or fall back visibly — it
 * renders one theme with a colour from the other, which is exactly the case the contrast
 * assertions above cannot reach because they only test the pairs someone remembered.
 */
describe("token parity across themes", () => {
  /** The three places a semantic token can be declared. */
  const DARK_BLOCK = block(':root[data-theme="dark"]');
  const LIGHT_BLOCK = block(':root[data-theme="light"]');

  /*
   * The media-query block, which stripMediaBlocks deliberately removes for the contrast
   * scan. Read from the raw source instead: it is the theme an OS preference selects,
   * so a token missing here is missing for every user who never touched the toggle.
   */
  const MEDIA = (() => {
    const source = TOKENS.replace(/\/\*[\s\S]*?\*\//g, "");
    const start = source.indexOf("@media (prefers-color-scheme: light)");
    if (start === -1) return new Map<string, string>();
    const open = source.indexOf("{", start);
    let depth = 0;
    let cursor = open;
    for (; cursor < source.length; cursor++) {
      if (source[cursor] === "{") depth += 1;
      else if (source[cursor] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const body = source.slice(open + 1, cursor);
    const merged = new Map<string, string>();
    for (const match of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      for (const [key, value] of declarationsOf(match[2]!)) merged.set(key, value);
    }
    return merged;
  })();

  /** Semantic tokens only: --rc-*. Primitives and geometry are not themed. */
  const semantic = (names: Iterable<string>) =>
    [...names].filter((name) => name.startsWith("--rc-")).sort();

  it("declares each theme's tokens in the other", () => {
    expect(semantic(LIGHT_BLOCK.keys())).toEqual(semantic(DARK_BLOCK.keys()));
  });

  it("declares every light token in the prefers-color-scheme block too", () => {
    /*
     * The two light sources must agree, or the toggle and the OS preference render
     * different apps. This is the half most easily forgotten: the explicit
     * [data-theme="light"] block is the one you are looking at when you add a token.
     */
    expect(semantic(MEDIA.keys())).toEqual(semantic(LIGHT_BLOCK.keys()));
  });

  it("finds a non-trivial number of tokens, so the parser cannot pass vacuously", () => {
    expect(semantic(DARK_BLOCK.keys()).length).toBeGreaterThan(20);
    expect(semantic(MEDIA.keys()).length).toBeGreaterThan(20);
  });
});
