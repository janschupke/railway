/**
 * Finishes the standalone build, which `next build` leaves incomplete on purpose.
 *
 * `output: "standalone"` emits `.next/standalone` — a server, a traced `node_modules` and
 * the compiled routes — but deliberately not `.next/static`. Next's reasoning is that a
 * CDN should serve those; this app is one replica behind Railway's edge and serves its own,
 * so they have to be copied in. Nothing warns when they are missing: the server starts, the
 * HTML renders, and every chunk, stylesheet and font 404s. A blank page with a 200.
 *
 * Runs as `postbuild`, so `pnpm build` is still the whole build and nobody has to remember
 * this. Every consumer of a production build depends on it — `pnpm start`,
 * playwright.config.ts, scripts/serve-e2e.ts and the Dockerfile's runtime stage.
 *
 * The two checks below are the point as much as the copy is. Both failures they catch are
 * silent at build time and expensive at run time, and both are one missing directory.
 *
 *   pnpm build   # runs this
 */

import { access, cp, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { DEFAULT_LOCALE } from "../src/i18n/config.ts";

const STANDALONE = ".next/standalone";

async function exists(path: string) {
  try {
    await access(resolve(path));
    return true;
  } catch {
    return false;
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!(await exists(`${STANDALONE}/server.js`))) {
  fail(
    `${STANDALONE}/server.js is missing. That is what \`output: "standalone"\` in ` +
      "next.config.ts produces, so either the build failed or the option was removed.",
  );
}

/*
 * The catalog reaches the trace through `outputFileTracingIncludes`, because
 * src/i18n/request.ts imports it with a template literal that static analysis cannot
 * follow. If that option is dropped the build still succeeds and the deployment 500s on
 * the first render — so it is asserted here rather than discovered there.
 */
if (!(await exists(`${STANDALONE}/messages/${DEFAULT_LOCALE}.json`))) {
  fail(
    `${STANDALONE}/messages/${DEFAULT_LOCALE}.json was not traced. ` +
      "next.config.ts must keep `outputFileTracingIncludes` for messages/**/*.json — " +
      "src/i18n/request.ts imports the catalog by template literal, which tracing " +
      "cannot resolve on its own.",
  );
}

await cp(resolve(".next/static"), resolve(`${STANDALONE}/.next/static`), {
  recursive: true,
});

/*
 * `next build` copies .env and .env.production into the standalone directory, and this
 * machine's .env holds real Railway credentials. Two consequences, both unwanted:
 *
 * The artefact-shaped one. .dockerignore already keeps .env out of the image build context
 * for exactly this reason — "a copied .env would bake this machine's real Railway
 * credentials into an image layer; service variables are the only channel" — and standalone
 * reintroduced the same copy one directory further along, where that rule does not reach.
 *
 * The one that bites first. server.js does `process.chdir(__dirname)` before listening, so
 * Next loads .env from *here*. `pnpm test:e2e` and `pnpm serve:e2e` run that server against
 * the fake Railway, and every variable they do not set explicitly would fall through to the
 * developer's real account.
 *
 * Removed rather than ignored, because a file that must not be read is worse than one that
 * is not there. Nothing reads it back: the deployment takes its configuration from service
 * variables and the e2e harness passes what it needs on the command line.
 */
for (const entry of await readdir(resolve(STANDALONE))) {
  if (entry === ".env" || entry.startsWith(".env.")) {
    await rm(resolve(STANDALONE, entry), { force: true });
  }
}
