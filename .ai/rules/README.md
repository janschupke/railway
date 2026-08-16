# Rules

What each rule file is for is in [AGENTS.md](../../AGENTS.md); what follows is the rule
about the rules.

## One fact, one home

**The surface that owns a fact is the one that argues it. Every other mention is a sentence
and a link.**

The cost of ignoring this is not tidiness. A fact copied into four files gets corrected in
one or two of them and left wrong in the rest, and the wrong copies are indistinguishable
from the right ones — the count of `sm:` utilities in `src/` has been wrong in three places
at once, each with a different number.

| Surface                  | Owns                                                                                                                | Never                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Inline comment           | Why _this code_ is shaped this way — a framework trap, a measurement local to the file, an alternative deleted here | Restating an ADR's argument. Link to it.                       |
| `docs/adr/`              | The decision, its context, and what was rejected                                                                    | Narrating its own history. A revision states what is true now. |
| `.ai/rules/`             | What you must do before writing code                                                                                | Reasoning at length. That is the ADR's job.                    |
| `README.md`              | Running it, deploying it, and the gates                                                                             | Restating a rule. Link to it.                                  |
| `walkthrough.md`         | The tour: what the app does, where its code is, and the index of every other surface                                | Arguing anything. It is signposts and links.                   |
| `docs/*.md`              | The long-form reference a reviewer wants and a runner does not — limitations, schema, tests, UI, performance, logs  | Restating a rule that has a home in `.ai/rules/`. Link to it.  |
| `SECURITY.md`            | The threat model, the findings and the accepted risks                                                               | —                                                              |
| `AGENTS.md`              | An index, and the excerpt an agent trips over first                                                                 | Anything not derivable from the files it links                 |
| `.cursor/rules/main.mdc` | Nothing. It is generated from `AGENTS.md`                                                                           | Being edited by hand — `pnpm cursor:check` fails locally       |
| `CLAUDE.md`              | Nothing. One line, `@AGENTS.md`                                                                                     | Growing content of its own                                     |

An ADR **is** revised in place rather than superseded, and the header carries a `Last revised`
date when it has been. Superseding suits a decision that was reversed; every revision here so far
has been the same decision holding under a new fact, and splitting those across two files made a
reader assemble the current position from a history. What is banned is the trace: an ADR states
what is true now, not what it used to claim.

## Numbers in prose rot, so prefer one that cannot

Three kinds, and they are not the same:

- **A measurement that argued a decision** — the 1,000 requests an hour, the `HEAD` versus
  `GET` rate-limit reading. These were true when the decision was made and the decision
  stands on them, so keep them — but only while nothing else in the tree states a different
  number for the same thing. When the code beside a measurement disagrees with it, the code
  wins and the prose is wrong, not historical.
- **A live count of the code** — how many `useState` call sites, how many event names, how
  many `sm:` utilities. These rot within a commit or two of being written, and every drift
  found in an audit so far has been one of these. Prefer not to write one; if the argument
  genuinely needs it, expect to re-measure it.
- **A configured value** — a coverage threshold, a bundle budget, a Node version. These
  have exactly one home already, which is the config file. Point at it rather than quoting
  it. Every quoted budget and Lighthouse ceiling in these files went stale, and the one in
  `lighthouserc.cjs` had been failing for several commits while the rules file still named
  the broken number.

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
  `AGENTS.md`, `graphql.generated.ts` from `operations.ts`. Both have a `--check` mode in
  `pnpm check`, but only `codegen:check` also runs in CI — `cursor:check` does not, so
  `main.mdc` can be committed stale with every gate green. Run `pnpm cursor:generate` after
  editing `AGENTS.md`.

Reach for prose only when none of the three applies.
