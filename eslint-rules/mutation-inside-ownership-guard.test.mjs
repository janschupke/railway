import rule from "./mutation-inside-ownership-guard.mjs";
import { ruleTester } from "./rule-tester.mjs";

const options = [
  {
    mutations: [
      "destroyContainer",
      "deleteVolume",
      "stopDeployment",
      "updateContainer",
    ],
    guard: "withManagedContainer",
    guardedHelpers: ["destroyManagedContainer"],
    resolvers: ["resolveManagedTarget"],
  },
];

ruleTester.run("mutation-inside-ownership-guard", rule, {
  valid: [
    {
      name: "inside the guard's callback",
      options,
      code: `withManagedContainer("destroy", formData, async (context) => {
        await destroyContainer(context.accessToken, context.target.serviceId);
      });`,
    },
    {
      /*
       * The shape the byte-offset test could not express, and the reason it forced a
       * 1,574-line module: the guard is opened by a factory and the mutation sits inside
       * the callback it returns, which is textually above every exported action.
       */
      name: "inside a callback returned by a factory",
      options,
      code: `function deploymentAction(verb) {
        return (formData) =>
          withManagedContainer(verb, formData, async (context) => {
            await stopDeployment(context.accessToken, context.target.deploymentId);
          });
      }`,
    },
    {
      name: "inside a helper that takes an already-resolved target",
      options,
      code: `async function destroyManagedContainer(accessToken, context, volume) {
        await destroyContainer(accessToken, context.target.serviceId);
        if (volume) await deleteVolume(accessToken, volume.volumeId);
      }`,
    },
    {
      name: "a call to that helper, from inside the guard",
      options,
      code: `withManagedContainer("destroy", formData, async (context) => {
        await destroyManagedContainer(context.accessToken, context, volume, true);
      });`,
    },
    {
      /*
       * The batch. It reads the container list once and resolves each id against it in a
       * loop, so there is no callback to be inside — the check is the narrowing on
       * `resolution.managed`, which the compiler enforces because ManagedResolution is a
       * discriminated union and `.target` does not exist on the other branch.
       */
      name: "in a function that resolves ownership for itself",
      options,
      code: `async function destroyMany(accessToken, containers, serviceIds) {
        for (const id of serviceIds) {
          const resolution = resolveManagedTarget(containers, id);
          if (!resolution.managed) continue;
          await destroyManagedContainer(accessToken, { target: resolution.target });
        }
      }`,
    },
    {
      name: "a name that is not a mutation",
      options,
      code: `await getProjectContainers(accessToken, projectId, environmentId);`,
    },
  ],

  invalid: [
    {
      name: "a bare mutation at the top of an action",
      options,
      code: `export async function spinDown(_prev, formData) {
        await destroyContainer(accessToken, formData.get("serviceId"));
      }`,
      errors: [{ messageId: "unguarded" }],
    },
    {
      name: "a mutation beside the guard rather than inside it",
      options,
      code: `withManagedContainer("destroy", formData, async () => {});
      await deleteVolume(accessToken, volumeId);`,
      errors: [{ messageId: "unguarded" }],
    },
    {
      /*
       * Naming a helper in guardedHelpers moves the obligation to its call sites; it does
       * not remove it. Without this case the allowlist would be a way out of the rule.
       */
      name: "a call to a guarded helper from outside the guard",
      options,
      code: `await destroyManagedContainer(accessToken, context, volume, true);`,
      errors: [{ messageId: "unguarded" }],
    },
    {
      name: "two unguarded mutations report separately",
      options,
      code: `await updateContainer(a, b);
      await destroyContainer(c, d);`,
      errors: [{ messageId: "unguarded" }, { messageId: "unguarded" }],
    },
  ],
});
