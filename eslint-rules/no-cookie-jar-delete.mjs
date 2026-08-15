/**
 * A cookie jar's `delete()` sends a removal with no `Secure`, which a browser rejects
 * for any `__Host-` cookie — so the session survives the sign-out that was supposed to
 * end it.
 *
 * Replaces the scanning half of src/cookie-removal.test.ts, which matched three regexes
 * over every file in the tree. The behavioural half of that file stays: what
 * `clearCookie` actually writes is a property of a function and is asserted by calling
 * it, which is the right shape and always was.
 *
 * The alias form is why this is a rule rather than three `no-restricted-syntax`
 * selectors. `const jar = await cookies(); jar.delete(name)` needs the binding resolved,
 * and the regex standing in for that only recognised `const|let|var … = await cookies(`
 * — so a destructured handle, or one that was never awaited, walked straight past it.
 */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow delete() on a response cookie jar; use clearCookie, which sends the full attribute set.",
    },
    schema: [],
    messages: {
      jarDelete:
        "A cookie jar's delete() sends a removal with no Secure, which a browser rejects for any __Host- cookie. Use clearCookie(jar, name, appUrl). This covers the response jar under any name and the next/headers cookies() jar, which is a response jar inside a Server Action or Route Handler; only the inbound edit, written in full as request.cookies.delete, is exempt.",
    },
  },

  create(context) {
    /** `cookies()` or `await cookies()` — the next/headers jar, however it is spelled. */
    function isCookiesCall(node) {
      const call = node.type === "AwaitExpression" ? node.argument : node;
      return (
        call?.type === "CallExpression" &&
        call.callee.type === "Identifier" &&
        call.callee.name === "cookies"
      );
    }

    /**
     * Whether an identifier is a jar handle — declared from `cookies()`, directly or
     * through another handle.
     *
     * Resolved through the scope rather than matched as text, so `const jar = await
     * cookies()` and `const jar = someJar` are both followed, and a parameter or an
     * import named `jar` is not.
     */
    function isJarBinding(node, seen = new Set()) {
      if (node.type !== "Identifier" || seen.has(node.name)) return false;
      seen.add(node.name);

      const variable = context.sourceCode
        .getScope(node)
        .references.find((reference) => reference.identifier === node)?.resolved;
      if (!variable) return false;

      return variable.defs.some((def) => {
        const init = def.node?.init;
        if (!init) return false;
        if (isCookiesCall(init)) return true;
        return isJarBinding(init, seen);
      });
    }

    return {
      "CallExpression > MemberExpression[property.name='delete']"(node) {
        const jar = node.object;

        /*
         * `request.cookies` is the one exempt jar and it is exempt for a reason rather
         * than by convention: editing the inbound request's cookies sends nothing to the
         * browser at all, so there is no removal to get wrong. Spelled in full, because
         * an exemption keyed on the property alone would let any object with a `cookies`
         * member through.
         */
        if (
          jar.type === "MemberExpression" &&
          jar.property.type === "Identifier" &&
          jar.property.name === "cookies"
        ) {
          const owner = jar.object;
          if (owner.type === "Identifier" && owner.name === "request") return;
          context.report({ node: node.parent, messageId: "jarDelete" });
          return;
        }

        if (isCookiesCall(jar) || isJarBinding(jar)) {
          context.report({ node: node.parent, messageId: "jarDelete" });
        }
      },
    };
  },
};

export default rule;
