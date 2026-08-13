import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Global stylesheet invariants that no rendering test can reach.
 *
 * jsdom applies no Tailwind and runs no animations, and the Playwright a11y suite forces
 * reduced motion — which is precisely why the popper bug below survived both. These read
 * the stylesheet and state the rule rather than the fix.
 */

const dir = import.meta.dirname;
const GLOBALS = readFileSync(path.join(dir, "globals.css"), "utf8");
const ui = (file: string) =>
  readFileSync(path.join(dir, "..", "components", "ui", file), "utf8");

/**
 * Declaration blocks whose selector mentions `needle`.
 *
 * Comments are stripped first, or a rule that merely *explains* the selector in prose
 * above itself would be read as using it.
 */
const rulesMatching = (css: string, needle: string) =>
  css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("}")
    .filter((block) => block.split("{")[0]?.includes(needle))
    .map((block) => block.split("{").slice(1).join("{"));

describe("popper animation", () => {
  it("never animates the positioning wrapper", () => {
    /*
     * [data-radix-popper-content-wrapper] carries Radix's inline positioning transform,
     * and a running animation outranks an inline style. Animating it — with *any*
     * property, since `animation` establishes a whole keyframe timeline — meant every
     * dropdown painted at the viewport's top-left corner for the duration and then
     * snapped into place.
     *
     * Stated as "no animation on that element", not "animate opacity instead", because
     * the opacity-only version is the fix people reach for next and it still costs a
     * frame of misplacement.
     */
    for (const rule of rulesMatching(GLOBALS, "[data-radix-popper-content-wrapper]")) {
      expect(rule).not.toMatch(/\banimation\s*:/);
    }
  });

  it("covers Tooltip's own spelling of open", () => {
    // Radix Tooltip content is never data-state="open"; it is delayed-open or
    // instant-open. A rule keyed only on "open" drops tooltip motion silently.
    expect(GLOBALS).toContain('[data-state="delayed-open"].animate-content');
    expect(GLOBALS).toContain('[data-state="instant-open"].animate-content');
  });

  it("is opted into by each portalled surface, rather than applied to all of them", () => {
    for (const file of [
      "tooltip.tsx",
      "alert-dialog.tsx",
      "combobox.tsx",
      "select.tsx",
    ]) {
      expect(ui(file), file).toContain("animate-content");
    }
  });

  it("gives a modal layer an entrance but no exit", () => {
    /*
     * Presence keeps a closing node mounted for as long as an animation runs on it, and
     * both of these hold something while they live — the select a scroll lock and
     * `aria-hidden` over the rest of the document, the tooltip a pointer-tracking layer.
     * Neither is a dismissal the user needs to see happen, so they arrive and then go.
     *
     * The dialog and the toast are the opposite case and animate both ways; they are
     * covered by the opt-in above.
     */
    for (const file of ["select.tsx", "tooltip.tsx"]) {
      expect(ui(file), file).toContain("animate-content-enter");
    }
  });
});

describe("the text-link affordance", () => {
  it("is a utility, and underlines on focus as well as hover", () => {
    const [rule] = rulesMatching(GLOBALS, ".link");
    expect(rule).toBeDefined();
    expect(rule).toContain("hover:underline");
    // Hover-only is the usual half-implementation; a keyboard user gets nothing from it.
    expect(rule).toContain("focus-visible:underline");
  });

  it("is never inherited by a button that happens to be an anchor", () => {
    /*
     * `Button asChild` renders "Open Railway" and "Sign in with Railway" as anchors. A
     * control is not a text link, and underlining it would make the footer's navigation
     * and the dashboard's actions read as the same kind of thing.
     *
     * Comments stripped: this file explains what a slotted anchor is, in prose, twice.
     */
    const code = ui("button.tsx")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/(?<![\w-])link(?![\w-])/);
  });
});
