# Rules

Nine files. What each one is for is in [AGENTS.md](../../AGENTS.md); what follows is the
rule about the rules, which is the thing that was missing.

## One fact, one home

Every claim about this app should be argued in exactly one place and linked to from
everywhere else. That was not true, and the cost was not tidiness: four correction passes
have gone through this repository fixing copies that had fallen out of step, and each pass
fixed some of the copies of a fact and missed others. "The app declares one `sm:`
breakpoint" was corrected here and left wrong in the README and in a component comment.
`codegen:check` was dropped from three of the four documents that list what `pnpm check`
runs. A test that compared two files byte for byte guarded their bullets and nothing else,
and required a broken link to keep passing.

So: **the surface that owns a fact is the one that argues it. Every other mention is a
sentence and a link.**

| Surface                  | Owns                                                                                                                | Never                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Inline comment           | Why _this code_ is shaped this way — a framework trap, a measurement local to the file, an alternative deleted here | Restating an ADR's argument. Link to it.           |
| `docs/adr/`              | The decision, its context, and what was rejected                                                                    | Being edited after the fact. Supersede it instead. |
| `.ai/rules/`             | What you must do before writing code                                                                                | Reasoning at length. That is the ADR's job.        |
| `README.md`              | What a reader needs to run, evaluate and review the app                                                             | Restating a rule. Link to it.                      |
| `SECURITY.md`            | The threat model, the findings and the accepted risks                                                               | —                                                  |
| `AGENTS.md`              | An index, and the excerpt an agent trips over first                                                                 | Anything not derivable from the files it links     |
| `.cursor/rules/main.mdc` | Nothing. It is generated from `AGENTS.md`                                                                           | Being edited by hand — `pnpm cursor:check` fails   |

## Numbers in prose rot, so prefer one that cannot

Three kinds, and they are not the same:

- **A measurement that argued a decision** — 504 MB against 44 MB, the 1,000 requests an
  hour, the twelve `style-src-attr` violations. These are historical: they were true when
  the decision was made and the decision stands on them. Keep them.
- **A live count of the code** — how many `useState` call sites, how many event names, how
  many lines in a directory. These rot within a commit or two of being written. Every
  drift found in the last audit was one of these. Prefer not to write one; if the argument
  genuinely needs it, expect to re-measure it.
- **A configured value** — a coverage threshold, a bundle budget, a Node version. These
  have exactly one home already, which is the config file. Point at it rather than quoting
  it; the README quoted the coverage thresholds and was wrong on two of four axes, because
  it had copied the _measured_ figures rather than the enforced ones.

## What is enforced, and by what

Not everything here can be checked, but more of it can than used to be. Before adding a
rule to one of these files, ask which of the three it is:

- **A lint rule** if one file's syntax decides it — `eslint-rules/` holds the ones this
  repo needed and no linter ships. It reports while you type and names its own fix.
- **A test** if it needs more than one file: reachability across the import graph
  (`protected-surfaces.test.ts`), agreement between a stylesheet and a component
  (`contrast.test.ts`, `type-scale.test.ts`), agreement between the toolchain files
  (`toolchain.test.ts`).
- **Generation** if one file is derived from another. `.cursor/rules/main.mdc` from
  `AGENTS.md`, `graphql.generated.ts` from `operations.ts`. A `--check` mode in `pnpm check`
  is what makes it a gate rather than a convention.

Prose is the fallback, not the default.
