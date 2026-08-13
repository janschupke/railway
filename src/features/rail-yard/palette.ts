/**
 * The scene's colours, which this feature does not own.
 *
 * A canvas needs real colour strings in JavaScript, and a feature component may not
 * write appearance — see .ai/rules/design-system.md. So every colour here is a `--rc-*`
 * semantic token declared in src/app/tokens.css and read back at runtime, which is also
 * what makes the yard follow the theme toggle without a second set of values.
 *
 * src/app/contrast.test.ts imports both lists below, so a token the renderer asks for
 * and tokens.css does not declare is a failing test rather than an invisible black
 * rectangle.
 */

export const RAIL_YARD_TOKENS = {
  skyHigh: "--rc-yard-sky-high",
  skyLow: "--rc-yard-sky-low",
  skyline: "--rc-yard-skyline",
  ground: "--rc-yard-ground",
  ballast: "--rc-yard-ballast",
  tie: "--rc-yard-tie",
  rail: "--rc-yard-rail",
  structure: "--rc-yard-structure",
  structureTrim: "--rc-yard-structure-trim",
  depot: "--rc-yard-depot",
  smoke: "--rc-yard-smoke",
  signalGo: "--rc-yard-signal-go",
  signalStop: "--rc-yard-signal-stop",
  loco: "--rc-yard-loco",
  locoTrim: "--rc-yard-loco-trim",
  metal: "--rc-yard-metal",
  shadow: "--rc-yard-shadow",
} as const;

/**
 * The container livery.
 *
 * Six steps rather than a generated ramp: they are walked in opposite directions per
 * theme (light violets on the dark ground, deep ones on the light) and two of them
 * borrow the existing sky and emerald primitives, so "multicoloured" costs no new ramp
 * and the yard still reads as this app's. Generating them in JS would put the values
 * back in TypeScript, which is the thing the token layer exists to prevent.
 */
export const FREIGHT_TOKENS = [
  "--rc-yard-freight-1",
  "--rc-yard-freight-2",
  "--rc-yard-freight-3",
  "--rc-yard-freight-4",
  "--rc-yard-freight-5",
  "--rc-yard-freight-6",
] as const;

export type PaletteKey = keyof typeof RAIL_YARD_TOKENS;

export type YardPalette = {
  readonly [K in PaletteKey]: string;
} & {
  readonly freight: readonly string[];
};

/**
 * Anything a canvas will accept as a colour.
 *
 * The check exists for one specific failure: an engine that hands back an unsubstituted
 * `var(--violet-300)` for a custom property. Assigning that to `fillStyle` is a silent
 * no-op that leaves the previous colour in place, so the yard would paint in whatever
 * happened to be set last rather than failing visibly.
 */
const COLOUR = /^(#|rgba?\(|hsla?\(|oklch\(|oklab\(|color\()/;

/**
 * Resolves the scene's colours, or nothing at all.
 *
 * `null` rather than a baked-in fallback. This feature owns no colours, and a hex
 * literal here is exactly the appearance the design system forbids it to write — so if
 * the token layer is not loaded the canvas stays transparent and the page shows
 * `--rc-canvas` through it, which is what the landing page looked like before the yard
 * existed. Degrading to "the page as it was" is the only acceptable failure mode for
 * decoration.
 */
export function resolvePalette(read: (token: string) => string): YardPalette | null {
  const resolved: Partial<Record<PaletteKey, string>> = {};

  for (const [key, token] of Object.entries(RAIL_YARD_TOKENS) as ReadonlyArray<
    [PaletteKey, string]
  >) {
    const value = read(token).trim();
    if (!COLOUR.test(value)) return null;
    resolved[key] = value;
  }

  const freight: string[] = [];
  for (const token of FREIGHT_TOKENS) {
    const value = read(token).trim();
    if (!COLOUR.test(value)) return null;
    freight.push(value);
  }

  return { ...(resolved as Record<PaletteKey, string>), freight };
}
