import rule from "./no-cookie-jar-delete.mjs";
import { ruleTester } from "./rule-tester.mjs";

ruleTester.run("no-cookie-jar-delete", rule, {
  valid: [
    {
      // The one exempt jar: editing the inbound request sends nothing to a browser, so
      // there is no removal to get wrong.
      name: "the inbound edit, spelled in full",
      code: `request.cookies.delete("rc_session");`,
    },
    {
      name: "clearCookie, which is the whole point",
      code: `clearCookie(response.cookies, "rc_session", appUrl);`,
    },
    {
      name: "delete on something that is not a cookie jar",
      code: `map.delete("key");`,
    },
    {
      name: "a local named jar that came from somewhere else",
      code: `function f(jar) { jar.delete("rc_session"); }`,
    },
  ],

  invalid: [
    {
      name: "the response jar",
      code: `response.cookies.delete("rc_session");`,
      errors: [{ messageId: "jarDelete" }],
    },
    {
      name: "a response jar under any other name",
      code: `res.cookies.delete("rc_session");`,
      errors: [{ messageId: "jarDelete" }],
    },
    {
      name: "the next/headers jar, awaited inline",
      code: `(await cookies()).delete("rc_session");`,
      errors: [{ messageId: "jarDelete" }],
    },
    {
      name: "the next/headers jar, not awaited",
      code: `cookies().delete("rc_session");`,
      errors: [{ messageId: "jarDelete" }],
    },
    {
      /*
       * The three forms below are why this is a rule and not a regex. The scan it
       * replaces recognised `const|let|var … = await cookies(` and nothing else.
       */
      name: "an awaited alias",
      code: `const jar = await cookies();\njar.delete("rc_session");`,
      errors: [{ messageId: "jarDelete" }],
    },
    {
      name: "an alias that was never awaited",
      code: `const jar = cookies();\njar.delete("rc_session");`,
      errors: [{ messageId: "jarDelete" }],
    },
    {
      name: "an alias of an alias",
      code: `const jar = await cookies();\nconst other = jar;\nother.delete("rc_session");`,
      errors: [{ messageId: "jarDelete" }],
    },
  ],
});
