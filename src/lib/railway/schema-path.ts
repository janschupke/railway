import { fileURLToPath } from "node:url";

/**
 * Where the committed copy of Railway's schema lives.
 *
 * Four things name this file — `scripts/pull-schema.ts` writes it, `codegen.ts` generates
 * from it, `scripts/verify-schema.ts` diffs the live API against it, and
 * `operations.test.ts` validates every document against it — so the path is stated once.
 *
 * Resolved from this module rather than from `process.cwd()`: the scripts run from the
 * repository root today, and a path that only works from there is a path that breaks the
 * first time one is invoked from anywhere else.
 *
 * Node-only by construction. Nothing in the app imports this; the schema is a build-time
 * artifact and shipping 175 kB of SDL to a browser would be absurd.
 */
export const SCHEMA_PATH = fileURLToPath(new URL("./schema.graphql", import.meta.url));
