/**
 * Settles what a delegated OAuth grant actually gets back from `Query.deployments`.
 *
 * The rollback control rests on three claims introspection cannot make. The schema says the
 * root field exists, takes `DeploymentListInput` and is not deprecated — it does not say
 * whether a *delegated* grant may call it, which order the edges arrive in, or what
 * `canRollback` answers for a deployment that is currently running versus one that is not.
 *
 *   RC_SESSION="<rc_session cookie value>" pnpm probe:deployments <projectId> <environmentId> <serviceId>
 *
 * The ordering question is the one with teeth. `DEPLOYMENTS_QUERY` asks for `last: N` on the
 * strength of the single observation this repo has of Railway's Relay semantics — the note
 * on `DEPLOYMENT_EVENTS_QUERY`, that edges arrive oldest-first and `last` slices the newest.
 * If deployments arrive newest-first instead, `last` returns the ten *oldest* and the panel
 * offers a history nobody wants, with nothing failing anywhere. `listServiceDeployments`
 * sorts afterwards so the rows on screen are still ordered correctly, which means this
 * script is the only thing that can catch it.
 *
 * **What it deliberately cannot answer**: whether `deploymentRollback` reuses a deployment id
 * or mints a new one. That mutation returns a Boolean, so the only way to observe it is to
 * perform a real rollback on a real account — and every probe here is read-only. Nothing in
 * the app depends on the answer: the row re-keys its log stream on whatever `deploymentId`
 * the refreshed container list reports, exactly as it does after a redeploy. README
 * Limitations records it as open.
 *
 * Uses the *session's own OAuth access token* rather than an account token, for the reason
 * probe-projects.ts gives: those two credentials have different visibility, and an account
 * token could establish that the capability exists while saying nothing about whether this
 * app could use it.
 *
 * Read-only. The one operation below is a query.
 */

import { openSession } from "../src/lib/auth/session.ts";
import { DEPLOYMENTS_QUERY } from "../src/lib/railway/operations.ts";
import { LIST } from "../src/lib/constants.ts";
import { RAILWAY_DEFAULTS } from "../src/env.ts";

const ENDPOINT = process.env.RAILWAY_API_URL ?? RAILWAY_DEFAULTS.API_URL;

const ok = (s: string) => `\x1b[32m✓\x1b[0m ${s}`;
const bad = (s: string) => `\x1b[31m✗\x1b[0m ${s}`;
const warn = (s: string) => `\x1b[33m!\x1b[0m ${s}`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

type DeploymentNode = {
  id: string;
  status?: string | null;
  createdAt?: string | null;
  canRollback?: boolean | null;
};

type Body = {
  data?: { deployments?: { edges?: Array<{ node: DeploymentNode }> } | null } | null;
  errors?: Array<{
    message: string;
    path?: string[];
    extensions?: { code?: string };
  }>;
};

const usage = (message: string) => {
  console.error(bad(message));
  console.error("  Take the three ids from a service's URL on Railway:");
  console.error(
    "    RC_SESSION='…' pnpm probe:deployments <projectId> <environmentId> <serviceId>\n",
  );
  process.exit(1);
};

async function main() {
  const cookie = process.env.RC_SESSION;
  const secret = process.env.SESSION_SECRET;
  const [projectId, environmentId, serviceId] = process.argv.slice(2);

  if (!secret) {
    console.error(bad("SESSION_SECRET is not set."));
    console.error("  Run through the package script, which loads .env:");
    console.error("    RC_SESSION=… pnpm probe:deployments <ids>\n");
    process.exit(1);
  }
  if (!cookie) {
    console.error(bad("RC_SESSION is not set."));
    console.error("  Sign in, then copy the `rc_session` cookie value:");
    console.error("    DevTools → Application → Cookies → rc_session\n");
    process.exit(1);
  }
  if (!projectId || !environmentId || !serviceId) {
    usage("Needs a project id, an environment id and a service id.");
    return;
  }

  const session = await openSession(cookie, secret);
  if (!session) {
    console.error(
      bad("Could not open that session — wrong SESSION_SECRET, or the cookie expired."),
    );
    process.exit(1);
  }

  console.log(`\nEndpoint: ${ENDPOINT}`);
  console.log(`Service:  ${serviceId}\n`);

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${session.accessToken}`,
    },
    body: JSON.stringify({
      query: DEPLOYMENTS_QUERY,
      variables: {
        input: { projectId, environmentId, serviceId },
        last: LIST.DEPLOYMENT_HISTORY,
      },
      operationName: "Deployments",
    }),
  });

  let body: Body;
  try {
    body = (await response.json()) as Body;
  } catch {
    console.error(bad(`non-JSON response (HTTP ${response.status})`));
    process.exit(1);
  }

  for (const error of body.errors ?? []) {
    /*
     * The code separates the two answers that matter. INTERNAL_SERVER_ERROR is Railway's
     * shape for "this token may not read that", which means the panel degrades and the app
     * is fine; GRAPHQL_VALIDATION_FAILED means the field or an argument is gone, which is a
     * code change and a failing `verify:schema`.
     */
    console.log(
      bad(
        `${error.path?.join(".") ?? "query"} → ${error.message} ` +
          `[${error.extensions?.code ?? "no code"}]`,
      ),
    );
  }

  const nodes = (body.data?.deployments?.edges ?? []).map((edge) => edge.node);
  if (nodes.length === 0) {
    console.log(
      warn("No deployments came back. The panel would say so and offer no rollback."),
    );
    console.log(
      dim("  Check the ids, or try a service that has deployed more than once."),
    );
    return;
  }

  console.log(`Deployments as returned (${nodes.length}, in Railway's own order)`);
  for (const node of nodes) {
    const rollback = node.canRollback ? ok("canRollback") : dim("canRollback: false");
    console.log(
      `  ${node.createdAt ?? dim("(no createdAt)")}  ${(node.status ?? "?").padEnd(12)} ${rollback}  ${dim(node.id)}`,
    );
  }

  /*
   * The claim under test. `last` only means "the newest N" if the connection is ordered
   * oldest-first, which is what DEPLOYMENT_EVENTS_QUERY observed and what this document
   * assumes.
   */
  const stamps = nodes.map((node) => node.createdAt ?? "");
  const ascending = stamps.every((value, i) => i === 0 || stamps[i - 1]! <= value);
  const descending = stamps.every((value, i) => i === 0 || stamps[i - 1]! >= value);

  console.log("\nEdge ordering");
  if (ascending && !descending) {
    console.log(
      ok("oldest first — `last: N` returns the newest N, as the document assumes"),
    );
  } else if (descending && !ascending) {
    console.log(
      bad(
        "newest first — `last: N` is returning the OLDEST N, which is the wrong page",
      ),
    );
    console.log(
      dim("  Change DEPLOYMENTS_QUERY to `first` and say why in its docblock."),
    );
  } else {
    console.log(warn("not conclusive — too few entries, or no createdAt to order by"));
  }

  console.log("\ncanRollback");
  const yes = nodes.filter((node) => node.canRollback).length;
  console.log(
    yes === nodes.length
      ? warn(
          `every one of the ${nodes.length} says yes — including the running one, if it is in this list`,
        )
      : ok(`${yes} of ${nodes.length} — Railway is distinguishing between them`),
  );
  console.log(
    dim(
      "  The app renders an entry Railway says no to, without a control. If the running\n" +
        "  deployment answers true here, the panel's own `Running now` marker is what\n" +
        "  keeps it from being offered — see DeploymentHistory.",
    ),
  );
}

/*
 * Not `await main()`. package.json declares no `"type": "module"`, so tsx transforms a .ts
 * script to CJS, where a top-level await is a hard transform error rather than a runtime
 * one. The other probes all end this way.
 */
main().catch((error: unknown) => {
  console.error(bad(`probe crashed: ${String(error)}`));
  process.exit(1);
});
