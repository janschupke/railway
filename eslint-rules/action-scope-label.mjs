/**
 * A Server Action's request scope is labelled with the action it is scoping.
 *
 * The label becomes `route` on every log line the request emits, so a stale one after a
 * rename sends an operator reading `stopContainer` to a function that has not existed for
 * months. The tidier-looking fix — a `scopedAction(name, fn)` helper generating the export
 * — is not available: a `"use server"` file may export only async functions, so
 * `export const x = scopedAction(…)` does not compile. Checking the agreement costs
 * nothing and catches the same drift.
 *
 * This replaces the first assertion in src/app/scope-labels.test.ts, which matched
 * `export async function (\w+)` and `withRequestScope\(\s*"([^"]+)"` over the file's text
 * and paired each call with the nearest export above it by index. That works only while
 * every action is in one file, and it said so out loud: `expect(calls.length)
 * .toBeGreaterThan(8)` required nine of the ten forwarders to stay in
 * app/dashboard/actions.ts, which made splitting that module impossible without deleting
 * the check. Per-export in the linter, the count is unnecessary — there is no set to be
 * empty.
 *
 * The rest of that file stays a test: the route-pattern labels need the route's path on
 * disk, and the `trustInboundId` agreement reads the proxy's matcher out of another
 * module, which is not something a per-file rule can see.
 */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a Server Action's withRequestScope label to match the exported function's name.",
    },
    schema: [
      {
        type: "object",
        properties: { scope: { type: "string" } },
        additionalProperties: false,
      },
    ],
    messages: {
      missing:
        '{{name}} opens no request scope, so its log lines carry no route and cannot be grouped with the request that caused them. Wrap the body in {{scope}}("{{name}}", …).',
      mismatched:
        'The request scope under {{name}} is labelled "{{label}}". The label becomes `route` on every log line this request emits, so a stale one sends an operator to a function that no longer exists. Use "{{name}}".',
    },
  },

  create(context) {
    const scope = context.options[0]?.scope ?? "withRequestScope";

    /** Exported async function declarations, by name, in source order. */
    const exported = new Map();
    /** The scope labels found inside each of them. */
    const labels = new Map();

    let isUseServer = false;

    /** The nearest enclosing exported action, or null. */
    function enclosingAction(node) {
      for (const ancestor of context.sourceCode.getAncestors(node).toReversed()) {
        if (
          ancestor.type === "FunctionDeclaration" &&
          ancestor.id !== null &&
          exported.get(ancestor.id.name) === ancestor
        ) {
          return ancestor.id.name;
        }
      }
      return null;
    }

    return {
      Program(node) {
        const first = node.body[0];
        isUseServer =
          first?.type === "ExpressionStatement" &&
          first.expression.type === "Literal" &&
          first.expression.value === "use server";

        if (!isUseServer) return;

        for (const statement of node.body) {
          if (
            statement.type === "ExportNamedDeclaration" &&
            statement.declaration?.type === "FunctionDeclaration" &&
            statement.declaration.async &&
            statement.declaration.id !== null
          ) {
            exported.set(statement.declaration.id.name, statement.declaration);
          }
        }
      },

      CallExpression(node) {
        if (!isUseServer) return;
        if (node.callee.type !== "Identifier" || node.callee.name !== scope) return;

        const name = enclosingAction(node);
        if (name === null) return;

        const [first] = node.arguments;
        const label =
          first?.type === "Literal" && typeof first.value === "string"
            ? first.value
            : null;

        if (label === null) return;
        labels.set(name, [...(labels.get(name) ?? []), { label, node }]);
      },

      "Program:exit"() {
        if (!isUseServer) return;

        for (const [name, declaration] of exported) {
          const found = labels.get(name);
          if (!found) {
            context.report({
              node: declaration.id,
              messageId: "missing",
              data: { name, scope },
            });
            continue;
          }
          for (const { label, node } of found) {
            if (label === name) continue;
            context.report({
              node,
              messageId: "mismatched",
              data: { name, label },
            });
          }
        }
      },
    };
  },
};

export default rule;
