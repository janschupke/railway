/*
 * An explicit `.ts` specifier, which nothing else under src/ carries.
 *
 * This module is reached from scripts/verify-schema.ts, so it is loaded by Node's
 * type-stripping loader as well as by Vitest — and that loader resolves specifiers as
 * written. `allowImportingTsExtensions` is on for exactly this reason (see
 * .ai/rules/workflow.md); nothing in the app imports this file, so no bundler ever sees it.
 */
import * as operations from "./operations.ts";

/** One GraphQL document, under the name it is exported as. */
export type NamedDocument = { export: string; document: string };

/**
 * Every document in operations.ts, derived rather than listed.
 *
 * `pnpm codegen`, `pnpm verify:schema` and operations.test.ts all need "the documents this
 * app sends", and a second list of them is a list that can disagree with the first. Every
 * string export of that module is a document — the fragment is module-private, and the two
 * remaining exports are arrays — so the set falls out of the module itself.
 *
 * What each consumer gets is the *interpolated* text, which is the string that goes on the
 * wire: the three documents that select `...ProjectFields` carry the fragment's own text
 * inside them. That is why validation happens per document rather than over one merged
 * set — merged, the fragment would be declared three times and nothing would validate.
 */
export const DOCUMENTS: NamedDocument[] = Object.entries(operations)
  .filter((entry): entry is [string, string] => typeof entry[1] === "string")
  .map(([name, document]) => ({ export: name, document }));
