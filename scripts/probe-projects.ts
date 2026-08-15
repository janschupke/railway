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

import { SCOPES } from "../src/lib/auth/oidc.ts";
import { railwayMetadata } from "../src/lib/auth/oidc-metadata.ts";
import { RAILWAY_DEFAULTS } from "../src/env.ts";
import {
  ENDPOINT,
  bad,
  dim,
  ok,
  openProbeSession,
  postGraphQL,
  warn,
} from "./probe-support.ts";

const ISSUER = process.env.RAILWAY_ISSUER ?? RAILWAY_DEFAULTS.ISSUER;

const USAGE = "RC_SESSION='<value>' pnpm probe:projects";

/**
 * Candidate sources for "projects this credential can see".
 *
 * `me.projects` is what the app queries today. The others exist because Railway's
 * schema is not published and their docs do not say which one an OAuth token is
 * expected to answer from — so we ask all of them and let the output decide.
 */
const SOURCES = [
  {
    name: "me (identity only — is the token usable at all?)",
    query: `query { me { id name email } }`,
  },
  {
    name: "me.projects (personal source the app queries)",
    query: `query { me { id projects { edges { node { id name } } } } }`,
  },
  {
    name: "me.workspaces[].projects (workspace source the app queries)",
    query: `query { me { workspaces { id name projects { edges { node { id name } } } } } }`,
  },
  {
    name: "me.workspaces[].team.projects (the older shape, kept for comparison)",
    query: `query { me { workspaces { id name team { id name projects { edges { node { id name } } } } } } }`,
  },
  {
    name: "projects (root field)",
    query: `query { projects { edges { node { id name } } } }`,
  },
];

/**
 * Does the OAuth token work anywhere at all?
 *
 * If userinfo answers and every GraphQL source says "Not Authorized", the token is
 * fine and the GraphQL API simply does not accept it — a different class of problem
 * from a missing scope, and one no amount of query-shape guessing would ever fix.
 */
async function probeUserinfo(token: string) {
  const endpoint = railwayMetadata(ISSUER).userinfo_endpoint!;
  const response = await fetch(endpoint, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await response.text();
  if (!response.ok) {
    console.log(bad(`userinfo → HTTP ${response.status}`));
    console.log(dim(`  ${body.slice(0, 300)}`));
    return;
  }
  console.log(ok(`userinfo → HTTP ${response.status}`));
  console.log(dim(`  ${body.slice(0, 300)}`));
}

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
  const session = await openProbeSession(USAGE);

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

  console.log("\nToken acceptance");
  await probeUserinfo(session.accessToken);

  console.log("\nProject sources");
  for (const source of SOURCES) {
    const body = await postGraphQL(session.accessToken, source.query);
    const [error] = body.errors ?? [];
    if (error) {
      // The code matters as much as the message: Railway answers an unauthorized field
      // with INTERNAL_SERVER_ERROR, and a genuinely unknown one with
      // GRAPHQL_VALIDATION_FAILED. Those are opposite problems.
      console.log(
        bad(
          `${source.name} → ${error.message} [${error.extensions?.code ?? "no code"}]`,
        ),
      );
      // Partial data is the interesting case: a refused field nulls itself and the rest
      // still resolves, which is exactly what the app now keeps rather than discarding.
      if (body.data) console.log(dim(`  partial data: ${JSON.stringify(body.data)}`));
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
