import path from "node:path";

/**
 * "The token never leaves the server", enforced on the axis that decides it.
 *
 * `no-restricted-imports` already bans the auth trio and the logger from
 * src/components, src/hooks and src/features. What it cannot do is select by *directive*:
 * flat config picks files by path, and whether a module reaches a browser bundle is
 * answered by `"use client"` on line one, not by which folder it sits in. Widening the
 * path rule to src/app/** fails immediately on layout.tsx, page.tsx and not-found.tsx,
 * which import getSession correctly because they are Server Components.
 *
 * This closes it from the other side, and a rule body can do what a `files` glob cannot:
 * read the directive and the imports in the same pass. It replaces
 * src/client-boundary.test.ts, which asserted the same property by reading every file in
 * the tree as text — correct, but invisible until CI, and silent about the fix.
 *
 * Both spellings of an import are resolved, because a pattern that only recognises the
 * one this repo happens to prefer is not a boundary. `@/lib/logger` and `../lib/logger`
 * are the same module and the second used to match nothing.
 */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow importing server-only modules from a file marked `use client`.",
    },
    schema: [
      {
        type: "object",
        properties: {
          modules: { type: "array", items: { type: "string" } },
          directories: { type: "array", items: { type: "string" } },
          messages: {
            type: "object",
            additionalProperties: { type: "string" },
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      // The config supplies the prose per guarded module; this is the fallback for one
      // that has been added to the list without a reason written next to it.
      forbidden:
        "{{specifier}} is server-only and this file is a client component, so importing it puts it in a browser bundle.",
      explained: "{{message}}",
    },
  },

  create(context) {
    const options = context.options[0] ?? {};
    const modules = options.modules ?? [];
    const directories = options.directories ?? [];
    const messages = options.messages ?? {};

    const src = path.resolve(context.cwd, "src");

    /** The guarded module this specifier names, or null. */
    function guardedBy(specifier) {
      let fromSrc;
      if (specifier.startsWith("@/")) {
        fromSrc = specifier.slice(2);
      } else if (specifier.startsWith(".")) {
        const resolved = path.resolve(path.dirname(context.filename), specifier);
        const relative = path.relative(src, resolved);
        // Outside src/ entirely — a package or a repo-root file, neither of which
        // these name.
        if (relative.startsWith("..")) return null;
        fromSrc = relative.split(path.sep).join("/");
      } else {
        return null;
      }

      if (modules.includes(fromSrc)) return fromSrc;
      return (
        directories.find((dir) => fromSrc === dir || fromSrc.startsWith(`${dir}/`)) ??
        null
      );
    }

    function report(node, specifier) {
      const guarded = guardedBy(specifier);
      if (guarded === null) return;

      const message = messages[guarded];
      if (message) {
        context.report({ node, messageId: "explained", data: { message } });
        return;
      }
      context.report({ node, messageId: "forbidden", data: { specifier } });
    }

    let isClientComponent = false;

    return {
      Program(node) {
        /*
         * The first *statement*, not the first line and not anywhere in the file.
         * A module that merely mentions "use client" inside a comment or a string is
         * not a client component, and treating it as one would ban imports from server
         * code that happens to describe the boundary in prose — which several modules
         * here do at length.
         */
        const first = node.body[0];
        isClientComponent =
          first?.type === "ExpressionStatement" &&
          first.expression.type === "Literal" &&
          first.expression.value === "use client";
      },

      ImportDeclaration(node) {
        if (!isClientComponent) return;
        report(node, node.source.value);
      },

      // `await import("@/lib/logger")` reaches a bundle exactly as a static import does.
      "ImportExpression > Literal[value=/^[.@]/]"(node) {
        if (!isClientComponent) return;
        report(node, node.value);
      },
    };
  },
};

export default rule;
