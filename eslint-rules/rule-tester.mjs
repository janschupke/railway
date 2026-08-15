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
 * every construct they match — a directive, an import, a call — is in the shared subset.
 * Adding typescript-eslint's parser here would test the parser rather than the rule.
 */
export const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2023,
    sourceType: "module",
  },
});

/** An absolute path under `src/`, which is what the rules resolve specifiers against. */
export const inSrc = (relative) => path.resolve(process.cwd(), "src", relative);
