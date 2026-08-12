/**
 * Answers "why is my project not on the dashboard?" with evidence instead of a guess.
 *
 * The dashboard's empty state is reached when Railway returns an empty project
 * connection. That is indistinguishable, from the outside, between four causes: the
 * consent granted a narrower scope than we asked for, the OAuth token sees a different
 * viewer than the browser session does, the projects hang off a field we do not query,
 * or there genuinely are none. This prints enough to tell them apart.
 *
 *   RC_SESSION="<rc_session cookie value>" pnpm probe:projects
 *
 * It deliberately uses the *session's own OAuth access token* rather than an account
 * token from railway.com/account/tokens. Those two credentials have different
 * visibility, and the whole question here is what the OAuth one can see — an account
 * token would answer a question nobody asked.
 *
 * Read-only: every query below is a query, never a mutation.
 *
 * Runs under `tsx`, not `node --experimental-strip-types` like its sibling scripts: it
 * imports the app's own session and scope definitions rather than restating them, and
 * those reach for the `@/` alias that bare node cannot resolve. Restating them is what
 * would let this script drift away from the thing it is diagnosing.
 */

import { openSession } from "../src/lib/auth/session.ts";
import { SCOPES } from "../src/lib/auth/oidc.ts";
import { RAILWAY_DEFAULTS } from "../src/env.ts";

const ENDPOINT = process.env.RAILWAY_API_URL ?? RAILWAY_DEFAULTS.API_URL;

const ok = (s: string) => `\x1b[32m✓\x1b[0m ${s}`;
const bad = (s: string) => `\x1b[31m✗\x1b[0m ${s}`;
const warn = (s: string) => `\x1b[33m!\x1b[0m ${s}`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

type GraphQLBody = {
  data?: unknown;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
};

async function run(token: string, query: string): Promise<GraphQLBody> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query }),
  });
  try {
    return (await response.json()) as GraphQLBody;
  } catch {
    return { errors: [{ message: `non-JSON response (HTTP ${response.status})` }] };
  }
}

/**
 * Candidate sources for "projects this credential can see".
 *
 * `me.projects` is what the app queries today. The others exist because Railway's
 * schema is not published and their docs do not say which one an OAuth token is
 * expected to answer from — so we ask all of them and let the output decide.
 */
const SOURCES = [
  {
    name: "me.projects (what the app queries today)",
    query: `query { me { id name email projects { edges { node { id name } } } } }`,
  },
  {
    name: "me.workspaces[].team.projects",
    query: `query { me { workspaces { id name team { id name projects { edges { node { id name } } } } } } }`,
  },
  {
    name: "projects (root field)",
    query: `query { projects { edges { node { id name } } } }`,
  },
];

/** Field names on a type, so we can see what actually hangs off `me`rather than guess. */
const TYPE_FIELDS = `query TypeFields($name: String!) {
  __type(name: $name) { name fields { name type { name kind ofType { name kind } } } }
}`;

async function introspectType(token: string, name: string) {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query: TYPE_FIELDS, variables: { name } }),
  });
  const body = (await response.json()) as {
    data?: { __type?: { fields?: Array<{ name: string }> } | null };
    errors?: Array<{ message: string }>;
  };

  const [error] = body.errors ?? [];
  if (error) {
    console.log(warn(`introspection of ${name} rejected: ${error.message}`));
    return;
  }
  const fields = body.data?.__type?.fields;
  if (!fields) {
    console.log(warn(`type ${name} not found`));
    return;
  }
  console.log(ok(`${name} fields: ${fields.map((f) => f.name).join(", ")}`));
}

async function main() {
  const cookie = process.env.RC_SESSION;
  const secret = process.env.SESSION_SECRET;

  if (!secret) {
    console.error(bad("SESSION_SECRET is not set."));
    console.error("  Run through the package script, which loads .env:");
    console.error("    RC_SESSION=… pnpm probe:projects\n");
    process.exit(1);
  }
  if (!cookie) {
    console.error(bad("RC_SESSION is not set."));
    console.error("  Sign in, then copy the `rc_session` cookie value:");
    console.error("    DevTools → Application → Cookies → rc_session\n");
    console.error("    RC_SESSION='<value>' pnpm probe:projects\n");
    process.exit(1);
  }

  const session = await openSession(cookie, secret);
  if (!session) {
    console.error(
      bad("Could not open that session — wrong SESSION_SECRET, or the cookie expired."),
    );
    process.exit(1);
  }

  console.log(`\nEndpoint: ${ENDPOINT}`);

  console.log("\nSession");
  console.log(ok(`viewer ${session.user.id} ${dim(session.user.email ?? "")}`));
  const granted = new Set(session.scope.split(/\s+/).filter(Boolean));
  for (const scope of SCOPES) {
    // A scope we asked for and did not get is, on its own, the whole answer.
    console.log(
      granted.has(scope) ? ok(`scope ${scope}`) : bad(`scope ${scope} NOT granted`),
    );
  }
  const extra = [...granted].filter(
    (s) => !SCOPES.includes(s as (typeof SCOPES)[number]),
  );
  if (extra.length) console.log(dim(`  also granted: ${extra.join(", ")}`));

  console.log("\nProject sources");
  for (const source of SOURCES) {
    const body = await run(session.accessToken, source.query);
    const [error] = body.errors ?? [];
    if (error) {
      console.log(bad(`${source.name} → ${error.message}`));
      continue;
    }
    console.log(ok(source.name));
    // Printed raw and whole: an empty connection and a null field look identical in a
    // count, and telling them apart is the entire point of running this.
    console.log(dim(`  ${JSON.stringify(body.data)}`));
  }

  console.log("\nSchema shape");
  // verify:schema only introspects root fields, so it cannot see what hangs off `me`.
  await introspectType(session.accessToken, "User");
  await introspectType(session.accessToken, "Query");

  console.log(
    `\n${warn("Read the raw payloads above before changing the query — that is what this is for.")}\n`,
  );
}

main().catch((error) => {
  console.error(bad(`probe crashed: ${String(error)}`));
  process.exit(1);
});
