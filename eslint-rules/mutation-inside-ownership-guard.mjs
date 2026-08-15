/**
 * "This app only changes containers it created", stated as a property of the call and
 * not of the file it sits in.
 *
 * None of the Railway mutations performs an ownership check of its own — each sends its
 * document and nothing else. What makes the rule true is that their callers re-derive
 * ownership from Railway's own response first, via `withManagedContainer`, and only act
 * on the target it resolves.
 *
 * This replaces the ordering assertion in src/lib/railway/mutation-callsites.test.ts,
 * which compared byte offsets: the string `!target.managed` had to appear in
 * app/dashboard/actions.ts before the first `destroyContainer(` in the same file. That
 * stood in for control flow and was not it — a helper defined above the guard and called
 * below it failed, and a helper defined below the guard and called from nowhere passed.
 * Worse, it welded the rule to a file layout: every mutation had to live in one 1,574-line
 * module, and `deploymentAction` branched on a verb instead of taking the mutation as a
 * parameter purely so the two names stayed textually visible to a regex.
 *
 * Lexical containment is the real property and it survives any layout. A mutation must sit
 * inside the guard's callback.
 *
 * `guardedHelpers` is the one concession, and it closes rather than opens a hole. A helper
 * like `destroyManagedContainer` takes an already-resolved target and issues two mutations,
 * so its body is legitimately outside the callback — but then *calls to it* are treated as
 * mutations in their own right and must themselves sit inside the guard. Naming a helper
 * here moves the obligation; it does not remove it.
 *
 * `resolvers` is the second entry point, and it exists because there are genuinely two. A
 * batch reads the container list once and resolves each id against it, so `destroyMany`
 * calls `resolveManagedTarget` in a loop rather than opening a callback per service — and
 * what makes that safe is stronger than lexical position: `ManagedResolution` is a
 * discriminated union, so `resolution.target` cannot be read without narrowing on
 * `managed` first, and the compiler enforces that. A function that calls a resolver has
 * done the check this rule is looking for.
 */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require Railway mutations to be called inside the ownership guard's callback.",
    },
    schema: [
      {
        type: "object",
        properties: {
          mutations: { type: "array", items: { type: "string" } },
          guard: { type: "string" },
          guardedHelpers: { type: "array", items: { type: "string" } },
          resolvers: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      unguarded:
        "{{name}} changes infrastructure and is not inside {{guard}}(…), so nothing has re-derived ownership from Railway's own response for it. A forged service id would be acted on. Move the call into the guard's callback and act on the target it resolves.",
    },
  },

  create(context) {
    const options = context.options[0] ?? {};
    const mutations = options.mutations ?? [];
    const guard = options.guard ?? "withManagedContainer";
    const guardedHelpers = options.guardedHelpers ?? [];
    const resolvers = options.resolvers ?? [];

    // A call to a guarded helper carries the same obligation as the mutations inside it.
    const requiresGuard = new Set([...mutations, ...guardedHelpers]);

    const FUNCTIONS = new Set([
      "FunctionDeclaration",
      "FunctionExpression",
      "ArrowFunctionExpression",
    ]);

    /** The name a call expression invokes, for the plain `f(…)` shape these all use. */
    const calleeName = (node) =>
      node.callee.type === "Identifier" ? node.callee.name : null;

    /** Whether a subtree calls one of the resolvers, which is the check this looks for. */
    function callsResolver(node) {
      let found = false;
      const visit = (current) => {
        if (found || current === null || typeof current !== "object") return;
        if (Array.isArray(current)) {
          current.forEach(visit);
          return;
        }
        if (typeof current.type !== "string") return;
        if (
          current.type === "CallExpression" &&
          current.callee.type === "Identifier" &&
          resolvers.includes(current.callee.name)
        ) {
          found = true;
          return;
        }
        for (const key of context.sourceCode.visitorKeys[current.type] ?? []) {
          visit(current[key]);
        }
      };
      visit(node);
      return found;
    }

    function isSatisfied(node) {
      return context.sourceCode.getAncestors(node).some((ancestor) => {
        if (ancestor.type === "CallExpression" && calleeName(ancestor) === guard) {
          return true;
        }
        /*
         * Inside a guarded helper's own body. Only a function *declaration* counts: the
         * allowlist names things a reader can find by name, and an anonymous function
         * assigned to a matching identifier is not that.
         */
        if (
          ancestor.type === "FunctionDeclaration" &&
          ancestor.id !== null &&
          guardedHelpers.includes(ancestor.id.name)
        ) {
          return true;
        }
        // Inside a function that resolves ownership for itself, which the batch does.
        return FUNCTIONS.has(ancestor.type) && callsResolver(ancestor.body);
      });
    }

    return {
      CallExpression(node) {
        const name = calleeName(node);
        if (name === null || !requiresGuard.has(name)) return;
        if (isSatisfied(node)) return;
        context.report({ node, messageId: "unguarded", data: { name, guard } });
      },
    };
  },
};

export default rule;
