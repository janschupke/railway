import rule from "./action-scope-label.mjs";
import { ruleTester } from "./rule-tester.mjs";

ruleTester.run("action-scope-label", rule, {
  valid: [
    {
      name: "a forwarder whose label is its own name",
      code: `"use server";
      export async function spinDown(_prev, formData) {
        return withRequestScope("spinDown", { trustInboundId: true }, () => run(formData));
      }`,
    },
    {
      name: "two forwarders in one file",
      code: `"use server";
      export async function spinUp(_prev, formData) {
        return withRequestScope("spinUp", { trustInboundId: true }, () => a(formData));
      }
      export async function spinDown(_prev, formData) {
        return withRequestScope("spinDown", { trustInboundId: true }, () => b(formData));
      }`,
    },
    {
      /*
       * The rule is about Server Actions. A route handler labels its scope with the
       * route's own path, which is a different rule and stays a test — it needs the
       * file's position on disk, not the exported name.
       */
      name: "a file with no use server directive is not in scope",
      code: `export async function GET(request) {
        return withRequestScope("/api/health", { trustInboundId: false }, () => ok());
      }`,
    },
    {
      name: "a private helper is not an action",
      code: `"use server";
      async function create(formData) { return attempt(formData); }
      export async function spinUp(_prev, formData) {
        return withRequestScope("spinUp", { trustInboundId: true }, () => create(formData));
      }`,
    },
  ],

  invalid: [
    {
      name: "a label left behind by a rename",
      code: `"use server";
      export async function destroyContainerAction(_prev, formData) {
        return withRequestScope("spinDown", { trustInboundId: true }, () => run(formData));
      }`,
      errors: [{ messageId: "mismatched" }],
    },
    {
      name: "an action that opens no scope at all",
      code: `"use server";
      export async function spinDown(_prev, formData) {
        return run(formData);
      }`,
      errors: [{ messageId: "missing" }],
    },
    {
      /*
       * The count this replaces (`expect(calls.length).toBeGreaterThan(8)`) existed so a
       * file that had lost its calls could not pass vacuously. Per-export there is no set
       * to be empty: one action with no scope is one report.
       */
      name: "one of two actions loses its scope",
      code: `"use server";
      export async function spinUp(_prev, formData) {
        return withRequestScope("spinUp", { trustInboundId: true }, () => a(formData));
      }
      export async function spinDown(_prev, formData) {
        return b(formData);
      }`,
      errors: [{ messageId: "missing" }],
    },
  ],
});
