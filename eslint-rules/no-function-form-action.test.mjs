import rule from "./no-function-form-action.mjs";
import { ruleTester } from "./rule-tester.mjs";

ruleTester.run("no-function-form-action", rule, {
  valid: [
    {
      // The one legal action in the repo, and the reason a string is not banned: the
      // browser posts this itself, so React never touches it and sign-out survives a
      // broken hydration.
      name: "sign-out's string action",
      code: `<form action="/api/auth/logout" method="post"><button /></form>`,
    },
    {
      name: "the shape every other form uses now",
      code: `<form onSubmit={onSubmitWith(submit)}><input name="x" /></form>`,
    },
    {
      name: "a form with no action at all",
      code: `<form><input name="x" /></form>`,
    },
    {
      // Not resolvable from one file, and the rule says nothing rather than guessing. A
      // spread carrying a function action is a hole this rule does not close.
      name: "a spread with nothing named",
      code: `<form {...props} />`,
    },
    {
      /*
       * The widening to resist. Several components here take a function `action` prop and
       * are not form elements — this is the false positive that would follow from matching
       * any capitalised element with an `action`.
       */
      name: "a component that takes an action prop",
      code: `<ConfirmDestroyDialog action={spinDown} confirmToken="cache" />`,
    },
    {
      name: "another one, in the shape the create dialogs use",
      code: `<CreateNameDialog action={createProject} field="projectName" />`,
    },
    {
      name: "a submitter pointing at a URL",
      code: `<button type="submit" formAction="/api/auth/logout" />`,
    },
  ],

  invalid: [
    {
      name: "the shape four dialogs used to have",
      code: `<form action={submit} className="mt-4" />`,
      errors: [{ messageId: "functionAction" }],
    },
    {
      name: "useActionState's dispatcher, which is how the spin-up form did it",
      code: `<form action={formAction} onSubmit={guardDuplicate} />`,
      errors: [{ messageId: "functionAction" }],
    },
    {
      name: "an action written inline",
      code: `<form action={(formData) => submit(formData)} />`,
      errors: [{ messageId: "functionAction" }],
    },
    {
      // Not a string Literal to the parser, and React treats it as one — but a template
      // is where an interpolated expression would arrive, so it is reported rather than
      // special-cased.
      name: "a template literal",
      code: "<form action={`/api/${path}`} />",
      errors: [{ messageId: "functionAction" }],
    },
    {
      name: "a form nested somewhere the eye skips",
      code: `<div><section><form action={submit} /></section></div>`,
      errors: [{ messageId: "functionAction" }],
    },
    {
      // The evasion the rule exists to close: same code path, same reset, one attribute
      // away from a form that passes.
      name: "a submitter's formAction",
      code: `<form onSubmit={handle}><button type="submit" formAction={run} /></form>`,
      errors: [{ messageId: "functionFormAction" }],
    },
    {
      name: "the same on an input",
      code: `<input type="submit" formAction={run} />`,
      errors: [{ messageId: "functionFormAction" }],
    },
  ],
});
