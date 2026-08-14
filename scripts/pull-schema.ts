/**
 * Railway's schema, dumped to a file this repository owns.
 *
 * Railway publishes no schema artifact, so the only place one exists is the live API's
 * introspection response. This prints it as SDL into `src/lib/railway/schema.graphql`,
 * which is what `pnpm codegen` generates the operation types from and what
 * `pnpm verify:schema` diffs the live API against.
 *
 *   RAILWAY_TOKEN=<account or workspace token> pnpm schema:pull
 *
 * The artifact is committed on purpose. CI holds no RAILWAY_TOKEN, so a schema fetched at
 * build time would mean the typecheck and the codegen drift gate could not run there at
 * all — and a generated type nobody can regenerate is a type nobody can check. Committing
 * it also makes the diff readable: a Railway change to a field this app selects arrives as
 * lines in a pull request rather than as a runtime `undefined`.
 *
 * `printSchema` is the normaliser, which is why the file is in `.prettierignore`. Two dumps
 * of the same schema are byte-identical whatever order introspection answered in, and that
 * is the property the drift diff rests on.
 */

import { writeFileSync } from "node:fs";
import { buildClientSchema, getIntrospectionQuery, printSchema } from "graphql";
import { RAILWAY_DEFAULTS } from "../src/env.ts";
import { SCHEMA_PATH } from "../src/lib/railway/schema-path.ts";

const ENDPOINT = process.env.RAILWAY_API_URL ?? RAILWAY_DEFAULTS.API_URL;

const ok = (s: string) => `\x1b[32m✓\x1b[0m ${s}`;
const bad = (s: string) => `\x1b[31m✗\x1b[0m ${s}`;

async function main() {
  const token = process.env.RAILWAY_TOKEN;
  if (!token) {
    console.log(bad("RAILWAY_TOKEN is not set."));
    console.log("  Create one at https://railway.com/account/tokens, then re-run:");
    console.log("  RAILWAY_TOKEN=… pnpm schema:pull");
    process.exit(1);
  }

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    // Descriptions included: they are the only documentation Railway offers for most of
    // this, and a deprecation reason is a sentence the verify script prints verbatim.
    body: JSON.stringify({ query: getIntrospectionQuery({ descriptions: true }) }),
  });

  const body = (await response.json()) as {
    data?: Parameters<typeof buildClientSchema>[0];
    errors?: Array<{ message: string }>;
  };

  const [error] = body.errors ?? [];
  if (error) {
    console.log(bad(`introspection rejected: ${error.message}`));
    process.exit(1);
  }
  if (!body.data) {
    console.log(bad(`introspection returned no data (HTTP ${response.status})`));
    process.exit(1);
  }

  const sdl = `${printSchema(buildClientSchema(body.data))}\n`;
  writeFileSync(SCHEMA_PATH, sdl, "utf8");

  console.log(
    ok(`${SCHEMA_PATH} — ${sdl.split("\n").length} lines, ${sdl.length} bytes`),
  );
  console.log(
    "  Run `pnpm codegen` next; a document that no longer validates fails there.",
  );
}

main().catch((error: unknown) => {
  console.error(bad(`schema pull crashed: ${String(error)}`));
  process.exit(1);
});
