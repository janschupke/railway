import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Control geometry and motion, asserted against the files that define them.
 *
 * Same failure mode as the type scale, and the same reason for reading the CSS source
 * rather than rendering: Tailwind resolves `h-*` against the `--height-*` namespace and
 * `px-*` against `--padding-*`, so a token declared under any other name generates no
 * utility at all. The class still lands in the markup, still matches no rule, and the
 * control silently falls back to whatever its content happens to measure — which is
 * exactly how the preset chips ended up ten pixels shorter than the input beneath them.
 *
 * `duration-*` reads `--transition-duration-*`. Getting that one wrong compiles, passes
 * every render test, and leaves every transition at Tailwind's stock 150ms.
 */

const dir = import.meta.dirname;
const TOKENS = readFileSync(path.join(dir, "tokens.css"), "utf8");
const GLOBALS = readFileSync(path.join(dir, "globals.css"), "utf8");
const ui = (file: string) =>
  readFileSync(path.join(dir, "..", "components", "ui", file), "utf8");

const STEPS = ["sm", "md", "lg"] as const;
const DURATIONS = ["fast", "base", "slow"] as const;

const declared = (css: string, name: string) =>
  new RegExp(`^\\s*${name.replace(/[-]/g, "\\-")}:\\s*([^;]+);`, "m").exec(css)?.[1];

describe("control geometry", () => {
  it.each(STEPS)("defines a height and an inline inset for %s", (step) => {
    expect(declared(TOKENS, `--control-h-${step}`), "height").toBeDefined();
    expect(declared(TOKENS, `--control-px-${step}`), "inset").toBeDefined();
  });

  it.each(STEPS)("maps %s into the namespaces Tailwind actually reads", (step) => {
    expect(declared(GLOBALS, `--height-control-${step}`)).toBe(
      `var(--control-h-${step})`,
    );
    expect(declared(GLOBALS, `--padding-control-${step}`)).toBe(
      `var(--control-px-${step})`,
    );
  });

  it("gives every form-row control the same height and inset", () => {
    /*
     * The complaint this exists to answer: a button, an input and a select trigger sat at
     * three different heights and two different insets on the same row. Asserting on the
     * class rather than a computed style is deliberate — jsdom applies no Tailwind, and
     * the class is the thing a future edit would desync.
     */
    for (const file of ["button.tsx", "input.tsx", "select.tsx"]) {
      expect(ui(file), file).toContain("h-control-md");
      expect(ui(file), file).toContain("px-control-md");
    }
  });

  it("leaves no untokenised height on a control primitive", () => {
    // `max-h-*` is excluded on purpose: a popup's scroll ceiling is not a control
    // height and has nothing to line up with.
    for (const file of ["button.tsx", "input.tsx", "select.tsx"]) {
      expect(ui(file), file).not.toMatch(/(?<![\w-])h-\d/);
    }
  });
});

describe("motion tokens", () => {
  it.each(DURATIONS)("exposes %s as a duration utility", (duration) => {
    expect(declared(GLOBALS, `--transition-duration-${duration}`)).toBe(
      `var(--duration-${duration})`,
    );
  });

  it("makes the tokenised fast duration the default for bare transitions", () => {
    // Four components carry a plain `transition-colors`. Without this they run at
    // Tailwind's stock 150ms — a number that appears nowhere in this design system.
    expect(declared(GLOBALS, "--default-transition-duration")).toBe(
      "var(--duration-fast)",
    );
  });

  it("never declares --duration-* inside the theme, which generates nothing", () => {
    // The tokens live in tokens.css; the theme keys are spelled differently on purpose.
    const theme = GLOBALS.slice(
      GLOBALS.indexOf("@theme inline {"),
      GLOBALS.indexOf("\n}", GLOBALS.indexOf("@theme inline {")),
    );
    expect(theme).not.toMatch(/^\s*--duration-[\w-]+:/m);
  });
});
