import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * "The token never leaves the server", stated as a property of the whole tree.
 *
 * eslint.config.mjs bans lib/auth/session|refresh|server and lib/logger|lib/log/* from
 * src/components and src/hooks, which is where client components mostly live — and it is
 * the better tool for that, because it says so at the moment of typing.
 *
 * What it cannot do is decide on the directive. Flat config selects files by path, and
 * "is this a client component" is answered by `"use client"` on line one, not by which
 * folder it sits in. Widening the rule to src/app/** was tried and fails immediately on
 * layout.tsx, page.tsx and not-found.tsx, which import getSession *correctly* — they are
 * Server Components. So the directory is the wrong axis, and today the one "use client"
 * file outside the linted directories (app/dashboard/error.tsx) resolves with the ban
 * not in effect at all: it could import the JWE seal or pino and lint would pass.
 *
 * This closes it from the other side. The lint rule stays for the fast feedback; this
 * asserts the invariant the rule is a proxy for, on the axis that actually decides it.
 */

const SRC = path.resolve(import.meta.dirname);

/**
 * Modules that must never reach a browser bundle.
 *
 * The auth trio because they hold the token and the key derivation; the logger because
 * it is pino writing to the server's stdout, which in a browser is both dead weight and
 * a channel that does not exist.
 */
const SERVER_ONLY = [
  /@\/lib\/auth\/(session|refresh|server)/,
  /@\/lib\/logger/,
  /@\/lib\/log\//,
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (!/\.tsx?$/.test(entry.name)) return [];
    if (/\.test\.tsx?$/.test(entry.name)) return [];
    // Harness, not shipped code.
    if (path.relative(SRC, full).startsWith(`test${path.sep}`)) return [];
    return [full];
  });
}

/** Files whose first statement is the directive, which is the only thing that counts. */
const clientComponents = sourceFiles(SRC).filter((file) => {
  const head = readFileSync(file, "utf8")
    // Leading comments and blank lines are allowed before the directive.
    .replace(/^\s*(\/\*[\s\S]*?\*\/|\/\/.*)\s*/g, "")
    .trimStart();
  return /^["']use client["']/.test(head);
});

describe("the client boundary", () => {
  it("finds the client components it is meant to be checking", () => {
    // A directive-detection bug would empty this list and pass in silence.
    expect(clientComponents.length).toBeGreaterThan(10);
  });

  it.each(clientComponents.map((file) => [path.relative(SRC, file), file] as const))(
    "%s imports nothing that belongs to the server",
    (_relative, file) => {
      const code = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");

      const imports = [...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
      const forbidden = imports.filter((specifier) =>
        SERVER_ONLY.some((pattern) => pattern.test(specifier)),
      );

      expect(forbidden).toEqual([]);
    },
  );
});
