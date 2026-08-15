/**
 * React resets a `<form action={fn}>` once the action settles, and the reset silently
 * reverts every control React does not itself own.
 *
 * This is the home of that fact; the six or so places that used to restate it now point
 * here. The mechanism is not a quirk and not opt-outable — `startHostTransition` wraps the
 * action as `() => { requestFormReset(formFiber); return action(formData); }`, so the reset
 * is spliced in ahead of the action. Keeping the prop means keeping the reset.
 *
 * What React restores afterwards is what it controls: its own inputs and textareas. What it
 * does not restore, and what this repository actually renders:
 *
 *   - a Radix `Select`, which registers its own `reset` listener on the enclosing form and
 *     calls `setValue(initialValueRef.current)` — for a controlled Root that arrives back as
 *     an `onValueChange` to whatever the control mounted with;
 *   - an uncontrolled checkbox, which reverts to `defaultChecked`;
 *   - an uncontrolled text input, which is cleared outright.
 *
 * So on the failure path the form reads as "everything I entered is still here" while the
 * parts that are not controlled text have gone back to their defaults. It shipped twice:
 * a workspace select that moved a project back to the personal account after a refused
 * name, and a destroy dialog whose "also delete the stored data" box re-checked itself
 * while the typed confirmation kept the button armed.
 *
 * The fix is `onSubmit`, `preventDefault`, and calling the action by hand with
 * `new FormData(event.currentTarget)` — see `onSubmitWith` in src/components/ui/form.ts.
 * Every form here already called its action by hand inside a transition; the prop was only
 * ever building the FormData.
 *
 * A string action is left alone. `<form action="/api/auth/logout" method="post">` is a real
 * no-JS submission that React never touches, and sign-out is the one thing in this app that
 * has to work with a broken hydration.
 *
 * Restricted to the lowercase intrinsics, which is the widening to resist: several
 * components here legitimately take a function `action` prop — `CreateNameDialog`,
 * `ConfirmDestroyDialog`, `LifecycleActionDialog` — and none of them is a form element.
 * `formAction` on a submitter is included because it goes through the same code path with
 * the same reset, and banning one without the other leaves the ban an attribute away.
 */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow a function action on a form; submit through onSubmit, which does not reset the form.",
    },
    schema: [],
    messages: {
      functionAction:
        "React resets a <form action={fn}> once the action settles, which silently reverts a Radix Select, an uncontrolled checkbox and an uncontrolled input while leaving controlled text fields alone — so a refused submit sends something other than what is on screen. Submit through onSubmit instead: `onSubmit={onSubmitWith(submit)}` from ui/form.ts. A string action is fine; only a function one resets.",
      functionFormAction:
        "A submitter's formAction goes through the same path as a form action and resets the form the same way. Submit through the form's onSubmit instead — see onSubmitWith in ui/form.ts.",
    },
  },

  create(context) {
    /**
     * Whether an attribute's value is a plain string, which is the one legal form.
     *
     * `action="/api/auth/logout"` is a URL the browser posts to on its own. Anything else —
     * an identifier, an arrow, a template literal — is a value React has to call, and
     * calling it is what schedules the reset.
     */
    function isStringLiteral(value) {
      if (value === null) return false;
      if (value.type === "Literal") return typeof value.value === "string";
      // `action={"/x"}` reaches the same place by a longer road.
      return (
        value.type === "JSXExpressionContainer" &&
        value.expression.type === "Literal" &&
        typeof value.expression.value === "string"
      );
    }

    /** The tag name, or null for a member or namespaced element, which is never a form. */
    function tagName(node) {
      return node.name.type === "JSXIdentifier" ? node.name.name : null;
    }

    return {
      JSXAttribute(node) {
        if (node.name.type !== "JSXIdentifier") return;
        const element = node.parent;
        if (element?.type !== "JSXOpeningElement") return;

        const tag = tagName(element);
        if (node.name.name === "action" && tag === "form") {
          if (isStringLiteral(node.value)) return;
          context.report({ node, messageId: "functionAction" });
          return;
        }

        if (
          node.name.name === "formAction" &&
          (tag === "button" || tag === "input") &&
          !isStringLiteral(node.value)
        ) {
          context.report({ node, messageId: "functionFormAction" });
        }
      },
    };
  },
};

export default rule;
