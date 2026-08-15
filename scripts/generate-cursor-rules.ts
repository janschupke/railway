import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Writes `.cursor/rules/main.mdc` from `AGENTS.md`.
 *
 * The two files carried the same content and drifted, twice: `main.mdc` said "picks a
 * project and environment" where AGENTS.md said "picks **or creates**", and it said
 * `pnpm audit --prod` gates CI where AGENTS.md said the image and secret scans do too.
 *
 * What was guarding them made the second failure inevitable rather than catching it.
 * `toolchain.test.ts` compared the two files' `- **` bullets for byte equality — so the
 * prose around the bullets was unguarded, and worse, the byte equality *required* a broken
 * link: AGENTS.md's `[workflow.md](.ai/rules/workflow.md)` resolves from the repo root, and
 * copying it verbatim into `.cursor/rules/` points at `.cursor/rules/.ai/rules/workflow.md`,
 * which does not exist. Every other link in that file is written `../../`, by hand, because
 * those bullets were not the ones under test.
 *
 * Generation removes the class of problem instead of testing for one instance of it. The
 * relative links are rewritten for the file's depth, so they resolve from where it actually
 * sits, and `pnpm cursor:check` fails if the committed copy is stale — the same shape as
 * `codegen:check`, and for the same reason.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE = path.join(ROOT, "AGENTS.md");
const TARGET = path.join(ROOT, ".cursor", "rules", "main.mdc");

/**
 * Cursor reads the frontmatter and nothing else does, so it is the one thing this file
 * carries that AGENTS.md does not.
 */
const FRONTMATTER = `---
description: Railway Freight Loader — all assistant instructions
alwaysApply: true
---
`;

/**
 * The block `next dev` writes into AGENTS.md on every run.
 *
 * Excluded rather than copied: it is Next's message to an agent editing this app, it is
 * re-added automatically wherever it belongs, and duplicating a block another tool owns is
 * how the two files fall out of step in the first place.
 */
const GENERATED_BLOCK =
  /<!-- BEGIN:nextjs-agent-rules -->[\s\S]*?<!-- END:nextjs-agent-rules -->\n*/;

/** How far `.cursor/rules/main.mdc` sits below the root the source's links resolve from. */
const PREFIX = "../../";

export function render(source: string): string {
  const body = source
    .replace(GENERATED_BLOCK, "")
    /*
     * Root-relative markdown links, rewritten for this file's depth.
     *
     * Left alone: absolute URLs and anchors, neither of which resolves against the file's
     * directory, and links already written `./` or `../`. The lookahead spells the last
     * one as `\.{1,2}/` rather than `\.` — excluding every path that starts with a dot
     * silently skipped `.ai/rules/`, which is most of the links in this document.
     */
    .replace(/\]\((?!https?:|#|\.{1,2}\/)/g, `](${PREFIX}`)
    .trimStart();

  return `${FRONTMATTER}\n${body}`;
}

const rendered = render(readFileSync(SOURCE, "utf8"));

if (process.argv.includes("--check")) {
  const current = readFileSync(TARGET, "utf8");
  if (current !== rendered) {
    process.stderr.write(
      "`.cursor/rules/main.mdc` is stale. Run `pnpm cursor:generate` and commit the result.\n",
    );
    process.exit(1);
  }
  process.stdout.write("`.cursor/rules/main.mdc` is current.\n");
} else {
  writeFileSync(TARGET, rendered);
  process.stdout.write(`wrote ${path.relative(ROOT, TARGET)}\n`);
}
