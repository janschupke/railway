import rule from "./no-server-imports-in-client.mjs";
import { inSrc, ruleTester } from "./rule-tester.mjs";

const options = [
  {
    modules: ["lib/auth/session", "lib/auth/refresh", "lib/auth/server", "lib/logger"],
    directories: ["lib/log"],
    messages: { "lib/logger": "The logger writes to the server's stdout." },
  },
];

const component = inSrc("components/thing.tsx");

ruleTester.run("no-server-imports-in-client", rule, {
  valid: [
    {
      name: "a server component may import whatever it likes",
      filename: component,
      options,
      code: `import { getSession } from "@/lib/auth/server";`,
    },
    {
      name: "a client component may import a client module",
      filename: component,
      options,
      code: `"use client";\nimport { cn } from "@/lib/utils";`,
    },
    {
      name: "a string that merely mentions the directive is not one",
      filename: component,
      options,
      code: `const note = "use client";\nimport { log } from "@/lib/logger";`,
    },
    {
      name: "a package whose name happens to start the same way",
      filename: component,
      options,
      code: `"use client";\nimport pino from "pino";`,
    },
    {
      name: "a sibling module that is not guarded",
      filename: component,
      options,
      code: `"use client";\nimport { x } from "./sibling";`,
    },
  ],

  invalid: [
    {
      name: "the aliased spelling",
      filename: component,
      options,
      code: `"use client";\nimport { log } from "@/lib/logger";`,
      errors: [{ messageId: "explained" }],
    },
    {
      /*
       * The case the test this replaces could not see. Its patterns were anchored on
       * `@/lib/…`, so the relative spelling of the same module matched nothing — in the
       * file that existed specifically to be the backstop for the lint rule.
       */
      name: "the relative spelling of the same module",
      filename: component,
      options,
      code: `"use client";\nimport { log } from "../lib/logger";`,
      errors: [{ messageId: "explained" }],
    },
    {
      name: "a module under a guarded directory",
      filename: component,
      options,
      code: `"use client";\nimport { context } from "@/lib/log/context";`,
      errors: [{ messageId: "forbidden" }],
    },
    {
      name: "a dynamic import, which reaches a bundle the same way",
      filename: component,
      options,
      code: `"use client";\nconst { log } = await import("@/lib/logger");`,
      errors: [{ messageId: "explained" }],
    },
    {
      // A leading comment is not a body node, so the directive is still body[0].
      name: "the directive behind a docblock",
      filename: component,
      options,
      code: `/** Why this is a client component. */\n"use client";\nimport { sealSession } from "@/lib/auth/session";`,
      errors: [{ messageId: "forbidden" }],
    },
  ],
});
