import postcss, { type ChildNode, type Container, type Root } from "postcss";

/**
 * A real parse of the stylesheets, for the tests that assert things about them.
 *
 * Four test files each grew their own reader — `split("}")` in globals, two independent
 * brace matchers in contrast, `indexOf("@theme inline {")` in control-scale — and each
 * one is a parser that works on the CSS in the tree today. They failed the same way, and
 * quietly: a selector reformatted, a rule wrapped in `@media`, or a brace inside a string
 * moves text out from under the pattern, the match set goes empty, and every assertion
 * over it passes. Two of them were doing exactly that when this was written.
 *
 * PostCSS is already in the tree — Tailwind's own toolchain runs on it — so this is a
 * direct devDependency of something that was already installed rather than a new one.
 *
 * Lives under src/test/ because that is the harness: knip ignores it and coverage
 * excludes it, so a helper the tests share does not have to carry a coverage floor of
 * its own.
 */

const parse = (css: string): Root => postcss.parse(css);

/** Custom properties declared directly on `container`, in source order. */
function propertiesOf(container: Container<ChildNode>): Map<string, string> {
  const declarations = new Map<string, string>();
  container.each((node) => {
    if (node.type === "decl" && node.prop.startsWith("--")) {
      declarations.set(node.prop, node.value);
    }
  });
  return declarations;
}

/**
 * Every custom property declared under `selector`, merged in source order.
 *
 * Top-level only: a rule nested inside an at-rule is not counted, because `tokens.css`
 * carries a `prefers-color-scheme` block with its own `:root` and folding that into the
 * base declarations makes the two themes read as identical. Reach those through
 * `propertiesInAtRule` instead, which is what the light-theme parity case does.
 */
export function propertiesFor(css: string, selector: string): Map<string, string> {
  const merged = new Map<string, string>();
  for (const node of parse(css).nodes) {
    if (node.type !== "rule" || node.selector !== selector) continue;
    for (const [property, value] of propertiesOf(node)) merged.set(property, value);
  }
  return merged;
}

/** Every custom property declared under any rule inside `@<name> <params>`. */
export function propertiesInAtRule(
  css: string,
  name: string,
  params: string,
): Map<string, string> {
  const merged = new Map<string, string>();
  for (const node of parse(css).nodes) {
    if (node.type !== "atrule" || node.name !== name || node.params !== params) {
      continue;
    }
    node.each((child) => {
      if (child.type === "rule") {
        for (const [property, value] of propertiesOf(child))
          merged.set(property, value);
      } else if (child.type === "decl" && child.prop.startsWith("--")) {
        merged.set(child.prop, child.value);
      }
    });
  }
  return merged;
}

/**
 * The first value declared for `property`, wherever it is declared.
 *
 * Deliberately not scoped to a selector: the callers are asking "does this token exist
 * and what does it say", and every one of them is a token declared once.
 */
export function declaredValue(css: string, property: string): string | undefined {
  let found: string | undefined;
  parse(css).walkDecls(property, (declaration) => {
    found ??= declaration.value;
  });
  return found;
}

export type ParsedRule = { selector: string; body: string };

/**
 * Rules whose selector text contains `needle`, with their declarations as written.
 *
 * The body is text rather than a map because the callers assert on whole declarations —
 * `hover:underline` is a selector fragment inside an `@apply`, not a property.
 */
export function rulesMatching(css: string, needle: string): ParsedRule[] {
  const found: ParsedRule[] = [];
  parse(css).walkRules((rule) => {
    if (!rule.selector.includes(needle)) return;
    found.push({
      selector: rule.selector,
      body: rule.nodes
        .map((node) =>
          node.type === "decl" ? `${node.prop}: ${node.value}` : `${node}`,
        )
        .join("; "),
    });
  });
  return found;
}

/** The body of an at-rule, as its child nodes rendered back to text. */
export function atRuleBody(css: string, name: string, params: string): string {
  const bodies: string[] = [];
  parse(css).walkAtRules(name, (rule) => {
    if (rule.params !== params) return;
    // A statement at-rule (`@import …;`) has no nodes at all. Every caller here wants a
    // block, so an empty body is the honest answer rather than a crash.
    bodies.push((rule.nodes ?? []).map((node) => `${node}`).join("\n"));
  });
  if (bodies.length === 0) {
    throw new Error(`no @${name} ${params} block in this stylesheet`);
  }
  return bodies.join("\n");
}
