import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { rulesMatching as parseRules } from "@/test/css";

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
 * A parse rather than `split("}")`. The split version read a rule's selector as
 * "everything since the previous closing brace", which folds the comment above it into
 * the selector — hence the strip it needed — and breaks outright on anything nested,
 * where the text between two braces is not one rule's worth. It was also the reason the
 * popper case below found nothing at all.
 */
const rulesMatching = (css: string, needle: string) =>
  parseRules(css, needle).map((rule) => rule.body);

describe("popper animation", () => {
  it("never targets the positioning wrapper at all", () => {
    /*
     * [data-radix-popper-content-wrapper] carries Radix's inline positioning transform,
     * and a running animation outranks an inline style. Animating it — with *any*
     * property, since `animation` establishes a whole keyframe timeline — meant every
     * dropdown painted at the viewport's top-left corner for the duration and then
     * snapped into place.
     *
     * Stated as "no rule names it", not "no rule animates it", and the difference is the
     * whole assertion. The second is what this used to say, as `for (rule of matches)
     * expect(rule).not.toMatch(/animation:/)` — and no rule has ever named that selector
     * outside the comment above the content rule, which is stripped before matching. So
     * the loop ran zero times and the test reported success for as long as it existed.
     *
     * Nothing was wrong with the stylesheet; the wrapper is untargeted, which is the
     * strongest form of "never animated" and exactly what globals.css sets out to do. The
     * fix is to assert that rather than to assert a property of an empty set. A rule
     * appearing here is then a red build and a prompt to re-read the comment in
     * globals.css, which is where the reasoning lives — including the part about
     * `animation: opacity` being the fix people reach for next and still costing a frame.
     */
    expect(rulesMatching(GLOBALS, "[data-radix-popper-content-wrapper]")).toEqual([]);
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
    const rules = rulesMatching(GLOBALS, ".link");
    // Stated, not assumed: `.link` is a utility the app applies, so zero rules here is
    // the utility having been renamed out from under this test rather than a pass.
    expect(rules).not.toHaveLength(0);
    const [rule] = rules;
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
