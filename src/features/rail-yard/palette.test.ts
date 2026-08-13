import { describe, expect, it } from "vitest";
import {
  FREIGHT_TOKENS,
  RAIL_YARD_TOKENS,
  resolvePalette,
  type PaletteKey,
} from "./palette";

const ALL = [...Object.values(RAIL_YARD_TOKENS), ...FREIGHT_TOKENS];

const reader =
  (values: Record<string, string>, fallback = "#123456") =>
  (token: string) =>
    values[token] ?? fallback;

describe("the token lists", () => {
  it("names distinct custom properties", () => {
    expect(new Set(ALL).size).toBe(ALL.length);
    for (const token of ALL) expect(token.startsWith("--rc-yard-")).toBe(true);
  });
});

describe("resolvePalette", () => {
  it("resolves every key the renderer can ask for", () => {
    const palette = resolvePalette(reader({}))!;
    expect(palette).not.toBeNull();
    for (const key of Object.keys(RAIL_YARD_TOKENS) as PaletteKey[]) {
      expect(palette[key], key).toBe("#123456");
    }
    expect(palette.freight).toHaveLength(FREIGHT_TOKENS.length);
  });

  it("trims what the browser hands back", () => {
    // getPropertyValue returns a leading space for most declarations.
    const palette = resolvePalette(() => "  #abcdef  ")!;
    expect(palette.ground).toBe("#abcdef");
  });

  it("accepts every colour syntax the token file uses", () => {
    for (const value of [
      "#fff",
      "#a98cf4",
      "rgb(10 9 16 / 0.45)",
      "rgba(10, 9, 16, 0.45)",
      "hsl(240 10% 4%)",
      "oklch(0.5 0.2 280)",
    ]) {
      expect(
        resolvePalette(() => value),
        value,
      ).not.toBeNull();
    }
  });

  it("returns nothing when a token is missing", () => {
    /*
     * No baked-in fallback, deliberately. This feature owns no colours, and a hex literal
     * here is exactly the appearance the design system forbids it to write — so an
     * unanswered token layer leaves the canvas transparent and the page shows through,
     * which is what the landing page looked like before the yard existed.
     */
    expect(resolvePalette(() => "")).toBeNull();
    expect(resolvePalette(reader({}, ""))).toBeNull();
  });

  it("returns nothing when a var() comes back unsubstituted", () => {
    /*
     * The specific failure this guards. Assigning `var(--violet-300)` to fillStyle is a
     * silent no-op that leaves the previous colour in place, so the yard would paint in
     * whatever happened to be set last rather than failing where anyone could see it.
     */
    expect(resolvePalette(() => "var(--violet-300)")).toBeNull();
  });

  it("rejects a single bad token rather than resolving around it", () => {
    const scene = resolvePalette(reader({ [RAIL_YARD_TOKENS.rail]: "not-a-colour" }));
    expect(scene).toBeNull();

    const freight = resolvePalette(reader({ [FREIGHT_TOKENS[0]]: "" }));
    expect(freight).toBeNull();
  });

  it("keeps the freight colours in declaration order", () => {
    const values = Object.fromEntries(
      FREIGHT_TOKENS.map((token, index) => [token, `#00000${index}`]),
    );
    const palette = resolvePalette(reader(values))!;
    expect(palette.freight).toEqual(FREIGHT_TOKENS.map((_, index) => `#00000${index}`));
  });
});
