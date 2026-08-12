import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The type scale, asserted against the files that define it.
 *
 * Three things have to agree for a `text-<variant>` utility to exist at all: the size
 * and line-height in tokens.css, the `@theme inline` mapping in globals.css, and the
 * variant in the Text primitive. Miss the middle one and Tailwind silently generates
 * nothing — the class lands in the markup, matches no rule, and the element renders at
 * whatever it inherited. That failure is invisible in review and invisible in a unit
 * test that only renders components, because the class name is still there.
 *
 * Same idea as contrast.test.ts: read the source of truth rather than the output.
 */

const dir = import.meta.dirname;
const TOKENS = readFileSync(path.join(dir, "tokens.css"), "utf8");
const GLOBALS = readFileSync(path.join(dir, "globals.css"), "utf8");
const TEXT = readFileSync(path.join(dir, "..", "components", "ui", "text.tsx"), "utf8");
const UTILS = readFileSync(path.join(dir, "..", "lib", "utils.ts"), "utf8");

/** Every step the primitive offers. `badge` shares the caption size deliberately. */
const VARIANTS = [
  "display",
  "title",
  "heading",
  "body",
  "label",
  "caption",
  "mono",
] as const;

const declared = (css: string, name: string) =>
  new RegExp(`^\\s*${name.replace(/[-]/g, "\\-")}:\\s*([^;]+);`, "m").exec(css)?.[1];

describe("the type scale", () => {
  it.each(VARIANTS)("defines a size and a line-height for %s", (variant) => {
    expect(declared(TOKENS, `--type-${variant}-size`), "size").toBeDefined();
    expect(declared(TOKENS, `--type-${variant}-height`), "line-height").toBeDefined();
  });

  it.each(VARIANTS)("maps %s into the Tailwind theme", (variant) => {
    // Without both halves the utility is generated with no leading, or not at all.
    expect(declared(GLOBALS, `--text-${variant}`)).toBe(`var(--type-${variant}-size)`);
    expect(declared(GLOBALS, `--text-${variant}--line-height`)).toBe(
      `var(--type-${variant}-height)`,
    );
  });

  it.each(VARIANTS)("is reachable as a %s variant of Text", (variant) => {
    expect(TEXT).toContain(`text-${variant}`);
  });

  it.each(VARIANTS)("is known to tailwind-merge as a size, not a colour (%s)", (v) => {
    /*
     * The fourth place that has to agree. A step missing from TYPE_SCALE in utils.ts is
     * classified as a text colour and silently dropped wherever it shares a `cn()` call
     * with one — see the note there.
     */
    expect(UTILS).toMatch(new RegExp(`^\\s*"${v}",$`, "m"));
  });

  it("declares no font-weight token that would shadow a font family", () => {
    /*
     * `--font-weight-display` and `--font-display` both generate `font-display` in
     * Tailwind v4, and the weight would win — silently dropping Inter Tight from every
     * heading in the app. Weight lives in the Text primitive for exactly this reason.
     */
    // Anchored to a declaration: globals.css names the trap in a comment on purpose.
    expect(GLOBALS).not.toMatch(/^\s*--font-weight-[\w-]+:/m);
  });

  it("gives mono more leading than the sans step at the same size", () => {
    // The log pane needs the air, and this is the pair that drifted before.
    const mono = parseFloat(declared(TOKENS, "--type-mono-height") ?? "0");
    const caption = parseFloat(declared(TOKENS, "--type-caption-height") ?? "0");

    expect(declared(TOKENS, "--type-mono-size")).toBe(
      declared(TOKENS, "--type-caption-size"),
    );
    expect(mono).toBeGreaterThan(caption);
  });
});
