import path from "node:path";
import { RuleTester } from "eslint";
import { afterAll, describe, it } from "vitest";

/*
 * RuleTester runs its cases through whatever test hooks it is given, and defaults to
 * Mocha's globals. Vitest does not install globals here, so they are handed over
 * explicitly — without this every rule's cases collapse into one opaque assertion and a
 * failure names no case.
 */
RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

/**
 * A tester configured the way this repo's source is actually parsed.
 *
 * Plain ESM rather than the TypeScript parser: none of these rules reads a type, and
 * every construct they match — a directive, an import, a call, a JSX attribute — is in the
 * shared subset. Adding typescript-eslint's parser here would test the parser rather than
 * the rule.
 *
 * JSX is in that subset and espree supplies it behind a flag, which is what
 * `no-function-form-action` matches on. Both parsers emit the same ESTree nodes for it —
 * `JSXOpeningElement`, `JSXAttribute`, `JSXExpressionContainer` — so a rule written against
 * espree's output reads the real `.tsx` tree identically. Turning it on cannot change how
 * an existing case parses: not one of them contains a `<`.
 */
export const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2023,
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

/** An absolute path under `src/`, which is what the rules resolve specifiers against. */
export const inSrc = (relative) => path.resolve(process.cwd(), "src", relative);
