import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FREIGHT_TOKENS, RAIL_YARD_TOKENS } from "@/features/rail-yard/palette";
import { CONTAINER_STATES } from "@/lib/railway/types";
import { propertiesFor, propertiesInAtRule } from "@/test/css";

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
/**
 * Not WCAG either — hover feedback is not what identifies or operates a control, so
 * 1.4.11 does not reach it. This is the floor at which a highlighted row reads as
 * highlighted, and it exists because the pair it guards was at 1.00 on dark for the whole
 * life of the app: --rc-raised and --rc-subtle were the same declaration, so hovering an
 * option in any popup changed nothing. Both halves passed every other threshold alone.
 *
 * 1.25 rather than the placeholder floor above, and the ceiling is what sets it: a
 * highlighted row also carries accent-coloured text when it is the selected one, and that
 * pair has to clear AA. A lighter fill buys hover feedback with legibility, which is the
 * wrong trade — the assertion below holds both ends.
 */
const AA_HOVER = 1.25;
/**
 * Not WCAG either: Euclidean RGB distance below which two freight containers stop
 * reading as two colours. See the rail-yard block near the end of this file.
 */
const FREIGHT_SEPARATION = 60;

type Rgb = [number, number, number];

/**
 * Every custom property declared at the top level under `selector`.
 *
 * Two hand-written brace matchers used to do this and the media extractor below — one
 * stripping `@media` blocks, one walking `([^{}]+)\{([^{}]*)\}` — plus a comment strip to
 * keep prose above a rule out of its selector. `propertiesFor` parses instead, and takes
 * only top-level rules for the same reason the strip existed: the
 * `prefers-color-scheme: light` block carries its own nested `:root`, and folding it into
 * the base declarations makes both themes read as identical. Those values are duplicated
 * by the explicit `[data-theme]` overrides, which is what the app's own cascade relies on.
 *
 * The old version compared selector text with `===` after a trim, so
 * `:root[data-theme='dark']` in single quotes, or an extra space inside the brackets,
 * returned an empty map and every assertion over it passed.
 */
const block = (selector: string) => propertiesFor(TOKENS, selector);

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
  /*
   * The field warning, which is a signal colour used as plain text on a plain surface
   * rather than on its own tinted fill. The SIGNALS cases below check each signal against
   * `--rc-<signal>-bg`, which is the Banner's arrangement and not this one — a warning
   * inside a Field is one line of caption text on the card, with no fill behind it.
   */
  ["--rc-warning", "--rc-canvas"],
  ["--rc-warning", "--rc-surface"],
];

/*
 * Imported rather than restated, which is what makes this a gate rather than a list.
 * A tenth container state used to be free here: it would render a badge whose tokens
 * nothing had checked, because the copy in this file did not know about it. Now the case
 * set follows the union, and adding a state without its two tokens fails on `resolve`,
 * which throws for an unknown one.
 */
const STATES = [...CONTAINER_STATES];

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

  it("a search match is readable on the log pane's own fill", () => {
    /*
     * The same pair as the preset chip below, over a different backdrop: the pane fills
     * with --rc-subtle rather than --rc-surface, and those are two different colours in
     * the light theme. The <mark> wash is nearly invisible on it either way, which is
     * why the glyph colour is what actually distinguishes a match.
     */
    const pane = surface("--rc-subtle");
    const fill = resolve("--rc-accent-bg", theme, pane);
    const text = resolve("--rc-accent", theme, fill);
    expect(
      Number(contrast(text, fill).toFixed(2)),
      `log match in ${themeName}`,
    ).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it("the current search match is the loudest thing in the log pane", () => {
    // Opaque, so it composites over nothing — but it still has to stand off the pane it
    // sits in, which is the half the primary-button assertion above does not cover.
    const pane = surface("--rc-subtle");
    const fill = surface("--rc-accent");
    expect(
      Number(contrast(fill, pane).toFixed(2)),
      `current match block in ${themeName}`,
    ).toBeGreaterThanOrEqual(AA_LARGE);

    const label = resolve("--rc-accent-fg", theme, fill);
    expect(
      Number(contrast(label, fill).toFixed(2)),
      `current match text in ${themeName}`,
    ).toBeGreaterThanOrEqual(AA_NORMAL);
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

  it("a highlighted popup row is legible and visibly different from the popup", () => {
    /*
     * The pair that broke: every popup paints --rc-raised and highlights the row under
     * the cursor with --rc-highlight. Those were the same declaration on dark until this
     * token existed, so hovering an option changed nothing — and no assertion here would
     * have caught it, because both halves passed every threshold on their own.
     *
     * AA for the text, because that is a text-on-background pair the criteria reach;
     * AA_HOVER for the fill, which is not a pair they reach — see that constant.
     */
    const highlight = surface("--rc-highlight");
    expect(
      Number(contrast(resolve("--rc-text", theme, highlight), highlight).toFixed(2)),
      `text on highlight in ${themeName}`,
    ).toBeGreaterThanOrEqual(AA_NORMAL);

    /*
     * The pair this file did not have and a browser found instead: a Select row that is
     * both selected and under the cursor draws --rc-accent on --rc-highlight. Missing it
     * cost an axe failure in e2e and a second pass at the token, which is the whole
     * argument for asserting colour pairs here rather than only where they render.
     */
    expect(
      Number(contrast(resolve("--rc-accent", theme, highlight), highlight).toFixed(2)),
      `accent on highlight in ${themeName}`,
    ).toBeGreaterThanOrEqual(AA_NORMAL);

    const raised = surface("--rc-raised");
    expect(
      Number(contrast(highlight, raised).toFixed(2)),
      `highlight on raised in ${themeName}`,
    ).toBeGreaterThanOrEqual(AA_HOVER);
  });

  it.each(["warning", "danger"])(
    "a %s log line is readable on the pane's own fill",
    (tone) => {
      /*
       * The log pane fills with --rc-subtle rather than --rc-surface, and those are two
       * different colours in the light theme — so the SIGNALS cases above, which check
       * surface and raised, do not cover the surface a severity-coloured line actually
       * sits on.
       */
      const pane = surface("--rc-subtle");
      const text = resolve(`--rc-${tone}`, theme, pane);
      expect(
        Number(contrast(text, pane).toFixed(2)),
        `${tone} log line in ${themeName}`,
      ).toBeGreaterThanOrEqual(AA_NORMAL);
    },
  );

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
 * The rail yard on the landing page.
 *
 * The scene is decoration, so almost nothing here is a WCAG number — a container is not
 * text and carries none. What it has instead is a set of *bounded* claims, and the bounds
 * matter in both directions: this canvas sits behind the sign-in card, so its failure
 * mode is not "invisible", it is "shouty". A skyline that reads as loudly as the
 * foreground, or a sky whose gradient banding competes with the card, is the regression
 * worth catching, and neither is expressible as a minimum.
 *
 * The token lists are imported from the feature rather than restated. That is the whole
 * point: a colour the renderer asks for and tokens.css does not declare would otherwise
 * be an invisible black rectangle on a page nobody scans in both themes.
 */
describe.each(THEMES)("%s rail yard", (themeName, theme) => {
  const surface = (token: string) => resolve(token, theme, [0, 0, 0]);
  const ratio = (fg: string, bg: string) => {
    const background = surface(bg);
    return Number(contrast(resolve(fg, theme, background), background).toFixed(2));
  };

  const YARD_TOKENS = [...Object.values(RAIL_YARD_TOKENS), ...FREIGHT_TOKENS];

  it.each(YARD_TOKENS)("declares %s", (token) => {
    expect(theme.get(token), `${token} in ${themeName}`).toBeDefined();
  });

  it.each(FREIGHT_TOKENS)("%s reads as a box on the yard floor", (token) => {
    // AA_PLACEHOLDER: the same "still reads as a shape" floor the skeleton is held to.
    expect(
      ratio(token, "--rc-yard-ground"),
      `${token} on the ground in ${themeName}`,
    ).toBeGreaterThanOrEqual(AA_PLACEHOLDER);
  });

  it("keeps the container colours apart from one another", () => {
    /*
     * Not a contrast question. Two containers side by side have to read as two colours,
     * and a ratio cannot see that — violet-200 against violet-300 clears every contrast
     * floor in this file and is one badly printed box. Euclidean RGB distance is crude
     * and is the right kind of crude here, and it is what rejected the adjacent-rung
     * version of the freight ramp.
     */
    const colours = FREIGHT_TOKENS.map((token) => surface(token));
    for (let a = 0; a < colours.length; a++) {
      for (let b = a + 1; b < colours.length; b++) {
        const [first, second] = [colours[a]!, colours[b]!];
        const gap = Math.hypot(
          first[0] - second[0],
          first[1] - second[1],
          first[2] - second[2],
        );
        expect(
          Math.round(gap),
          `${FREIGHT_TOKENS[a]} vs ${FREIGHT_TOKENS[b]} in ${themeName}`,
        ).toBeGreaterThanOrEqual(FREIGHT_SEPARATION);
      }
    }
  });

  it("puts the rails on the ballast and the ties under them", () => {
    const rail = ratio("--rc-yard-rail", "--rc-yard-ballast");
    const tie = ratio("--rc-yard-tie", "--rc-yard-ballast");
    expect(rail, `rail in ${themeName}`).toBeGreaterThanOrEqual(AA_PLACEHOLDER);
    // Ties are texture, not structure: present, and never louder than the rail above.
    expect(tie, `tie in ${themeName}`).toBeGreaterThanOrEqual(1.2);
    expect(tie, `tie vs rail in ${themeName}`).toBeLessThan(rail);
  });

  it("lays the track bed on the ground rather than into it", () => {
    /*
     * The bug this exists for: the dark theme ran the ground, the ballast and the ties up
     * three neighbouring rungs of one ramp, at 1.23:1 and 1.22:1. Inside a banding step,
     * so the permanent way disappeared and the rails read as two bright lines floating on
     * nothing. Bounded above as well, because ballast is a shoulder of stone and not a
     * highlight — the yard would read as a runway if it shouted.
     */
    const ballast = ratio("--rc-yard-ballast", "--rc-yard-ground");
    expect(ballast, `ballast in ${themeName}`).toBeGreaterThanOrEqual(1.35);
    expect(ballast, `ballast in ${themeName}`).toBeLessThan(AA_LARGE);
  });

  it("keeps the sleepers darker than the stone they sit in", () => {
    /*
     * A direction, not a ratio — and that is why it needs its own assertion. Contrast is
     * symmetric, so the test above passes just as happily with the two the wrong way
     * round, which is what the dark theme actually shipped: ties lighter than the ballast,
     * so the track read as a pale ladder rather than as timber bedded in rock.
     */
    expect(
      luminance(surface("--rc-yard-tie")),
      `tie vs ballast in ${themeName}`,
    ).toBeLessThan(luminance(surface("--rc-yard-ballast")));
  });

  it("models the solids without recolouring them", () => {
    /*
     * The tilted-plan projection needs a roof to read brighter than the walls below it or
     * a wagon stops looking like a wagon. Both washes are bounded: enough to model the
     * form, not enough to turn a violet locomotive into a different colour, which is what
     * a heavier shade does to the one object on this canvas the eye has to find.
     */
    const shade = ratio("--rc-yard-face-shade", "--rc-yard-loco");
    const lit = ratio("--rc-yard-face-lit", "--rc-yard-loco");
    expect(shade, `face shade in ${themeName}`).toBeGreaterThanOrEqual(1.15);
    expect(shade, `face shade in ${themeName}`).toBeLessThanOrEqual(2.2);
    expect(lit, `face lit in ${themeName}`).toBeGreaterThanOrEqual(1);
    expect(lit, `face lit in ${themeName}`).toBeLessThanOrEqual(1.5);
  });

  it("makes the locomotive the focal object on the yard floor", () => {
    // 1.4.11's non-text floor. It is the one thing on this canvas the eye must find.
    expect(
      ratio("--rc-yard-loco", "--rc-yard-ground"),
      `locomotive in ${themeName}`,
    ).toBeGreaterThanOrEqual(AA_LARGE);
  });

  it("keeps the sheds readable without making them shout", () => {
    const shed = ratio("--rc-yard-structure", "--rc-yard-ground");
    expect(shed, `shed in ${themeName}`).toBeGreaterThanOrEqual(AA_PLACEHOLDER);
    expect(shed, `shed in ${themeName}`).toBeLessThan(AA_NORMAL);
  });

  it("keeps the sky a gradient rather than a band", () => {
    expect(
      ratio("--rc-yard-sky-high", "--rc-yard-sky-low"),
      `sky in ${themeName}`,
    ).toBeLessThanOrEqual(2.5);
  });

  it("holds the skyline back", () => {
    const skyline = ratio("--rc-yard-skyline", "--rc-yard-sky-low");
    expect(skyline, `skyline in ${themeName}`).toBeGreaterThanOrEqual(1.1);
    expect(skyline, `skyline in ${themeName}`).toBeLessThanOrEqual(2.2);
  });

  it("shows the signal aspects against the sky, and the post against the ground", () => {
    /*
     * The lamp is wider than the post it stands on, so what is behind it is the sky —
     * asserting it against the post was the first version of this and it measured the
     * one background the lamp barely touches. The post is the thing that has to read
     * against the ground, and they are two different claims.
     *
     * Red against green carries no information a colour-blind visitor would miss: the
     * lamp is decoration, and every state it reports is already visible as a train
     * standing still.
     */
    for (const aspect of [
      "--rc-yard-signal-go",
      "--rc-yard-signal-caution",
      "--rc-yard-signal-stop",
    ]) {
      expect(
        ratio(aspect, "--rc-yard-sky-low"),
        `${aspect} in ${themeName}`,
      ).toBeGreaterThanOrEqual(AA_LARGE);
    }
    expect(
      ratio("--rc-yard-structure-trim", "--rc-yard-ground"),
      `signal post in ${themeName}`,
    ).toBeGreaterThanOrEqual(AA_PLACEHOLDER);
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
  const MEDIA = propertiesInAtRule(TOKENS, "media", "(prefers-color-scheme: light)");

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
