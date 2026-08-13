/**
 * Per-route first-load JS budget.
 *
 * Next 16 stopped printing route sizes, so a bundle regression is otherwise invisible
 * until someone profiles the deployed app. It does still write
 * `.next/diagnostics/route-bundle-stats.json`, which lists the exact chunks each route
 * loads first — that is what this reads.
 *
 * Why not size-limit: Turbopack hashes every chunk filename, so a config could only
 * match globs, and a glob sums a directory rather than answering "what does /dashboard
 * cost". The manifest gives the real per-route answer, and gzip is what users download.
 *
 *   pnpm build && pnpm size
 */

import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const STATS = ".next/diagnostics/route-bundle-stats.json";
const BUDGETS = "bundle-budgets.json";

type RouteStats = { route: string; firstLoadChunkPaths: string[] };
type Budgets = {
  /** Prose. Every routes number must appear here — see the rationale check below. */
  $comment: string[];
  routes: Record<string, number>;
};

const KB = 1024;

function read<T>(path: string, hint: string): T {
  try {
    return JSON.parse(readFileSync(resolve(path), "utf8")) as T;
  } catch {
    console.error(`Could not read ${path}. ${hint}`);
    process.exit(1);
  }
}

const stats = read<Record<string, RouteStats>>(
  STATS,
  "Run `pnpm build` first — this file is written by the production build.",
);
const budgets = read<Budgets>(BUDGETS, "Expected it at the repo root.");

const rows = Object.values(stats).map((route) => {
  const bytes = route.firstLoadChunkPaths.reduce(
    (total, chunk) => total + gzipSync(readFileSync(resolve(chunk))).length,
    0,
  );
  const budget = budgets.routes[route.route];
  return { route: route.route, kb: bytes / KB, budget };
});

let failed = false;
let unbudgeted = false;

console.log("\nFirst-load JS, gzipped\n");
for (const { route, kb, budget } of rows.sort((a, b) => b.kb - a.kb)) {
  const size = `${kb.toFixed(1)} kB`.padStart(10);

  if (budget === undefined) {
    // A new route with no budget is a gap in the gate, not a pass.
    console.log(`  ?  ${route.padEnd(16)}${size}   no budget set`);
    unbudgeted = true;
    continue;
  }

  const over = kb > budget;
  failed ||= over;
  const delta = kb - budget;
  const note = over
    ? `OVER by ${delta.toFixed(1)} kB`
    : `${Math.abs(delta).toFixed(1)} kB under ${budget} kB`;
  console.log(`  ${over ? "✗" : "✓"}  ${route.padEnd(16)}${size}   ${note}`);
}

if (unbudgeted) {
  console.error(
    "\nEvery route needs a budget, or the gate silently stops covering new pages." +
      `\nAdd it to ${BUDGETS}.`,
  );
}

/*
 * Every number must be argued for somewhere.
 *
 * performance.md makes "raising a budget needs a written reason" a headline rule, and it
 * was the one rule in this file nothing enforced — a number could be nudged up in the
 * same commit that made it necessary, with no trace of why, and the gate would go green
 * and stay green. Raising a budget is the one edit here that must not be quiet.
 *
 * Checked as "the number appears in the $comment prose" rather than by diffing against
 * git: it needs no history, works on a fresh clone, and it fails on exactly the change
 * worth reviewing — a new value nobody wrote about. It cannot tell a good reason from a
 * bad one, which is the reviewer's job; it can only insist that one was offered.
 */
const rationale = budgets.$comment.join("\n");
const unexplained = Object.entries(budgets.routes).filter(
  ([, budget]) => !new RegExp(`\\b${budget}\\b`).test(rationale),
);

if (unexplained.length > 0) {
  console.error("\nBudget numbers with no stated reason:\n");
  for (const [route, budget] of unexplained) {
    console.error(`  ${route.padEnd(16)}${String(budget).padStart(6)} kB`);
  }
  console.error(
    `\nRaising a budget needs a written reason — see performance.md.` +
      `\nAdd a line to the "$comment" array in ${BUDGETS} saying what grew and why,` +
      `\nnaming the new number. Measure with \`pnpm build && pnpm size\`.\n`,
  );
}

if (failed || unbudgeted || unexplained.length > 0) {
  console.error("\nBundle budget exceeded.\n");
  process.exit(1);
}

console.log("\nAll routes within budget.\n");
