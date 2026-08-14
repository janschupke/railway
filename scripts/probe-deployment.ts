/**
 * Settles the one thing about a failed deployment this app still guesses at.
 *
 * `deploymentEvents` and its `DeploymentEventPayload` were confirmed by introspecting
 * Railway's live schema, so the document the app sends is known to be valid. What
 * introspection cannot say is which of `payload.error`, `payload.reason` and
 * `payload.detail` Railway actually *populates* when a deployment fails — that needs a
 * real failed deployment, which neither CI nor a fixture can conjure.
 *
 * So the app tries all three in a documented order and this script checks that order
 * against reality:
 *
 *   RC_SESSION="<rc_session cookie value>" pnpm probe:deployment <deployment-id>
 *
 * It prints every event verbatim, then what `pickFailureReason` chose from them. If the
 * populated member is not the one the picker preferred, reorder TEXT_MEMBERS in
 * src/lib/railway/failure-reason.ts and correct the README's Limitations entry — nothing
 * else in the app depends on which one won.
 *
 * Uses the *session's own OAuth access token* rather than an account token, for the same
 * reason probe-projects.ts does: those two credentials have different visibility, and the
 * question here is what the OAuth one can see.
 *
 * Read-only. The one operation below is a query.
 *
 * Runs under `tsx` rather than bare node, because it imports the app's own session layer
 * and its own picker through the `@/` alias — restating either is what would let this
 * script drift away from the thing it is checking.
 */

import { openSession } from "../src/lib/auth/session.ts";
import { pickFailureReason } from "../src/lib/railway/failure-reason.ts";
import { DEPLOYMENT_EVENTS_QUERY } from "../src/lib/railway/operations.ts";
import { STREAM } from "../src/lib/constants.ts";
import { RAILWAY_DEFAULTS } from "../src/env.ts";

const ENDPOINT = process.env.RAILWAY_API_URL ?? RAILWAY_DEFAULTS.API_URL;

const ok = (s: string) => `\x1b[32m✓\x1b[0m ${s}`;
const bad = (s: string) => `\x1b[31m✗\x1b[0m ${s}`;
const warn = (s: string) => `\x1b[33m!\x1b[0m ${s}`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

type EventNode = {
  step?: string | null;
  payload?: Record<string, unknown> | null;
};

type Body = {
  data?: { deploymentEvents?: { edges?: Array<{ node: EventNode }> } | null } | null;
  errors?: Array<{
    message: string;
    path?: string[];
    extensions?: { code?: string };
  }>;
};

async function main() {
  const cookie = process.env.RC_SESSION;
  const secret = process.env.SESSION_SECRET;
  const deploymentId = process.argv[2];

  if (!secret) {
    console.error(bad("SESSION_SECRET is not set."));
    console.error("  Run through the package script, which loads .env:");
    console.error("    RC_SESSION=… pnpm probe:deployment <deployment-id>\n");
    process.exit(1);
  }
  if (!cookie) {
    console.error(bad("RC_SESSION is not set."));
    console.error("  Sign in, then copy the `rc_session` cookie value:");
    console.error("    DevTools → Application → Cookies → rc_session\n");
    console.error("    RC_SESSION='<value>' pnpm probe:deployment <deployment-id>\n");
    process.exit(1);
  }
  if (!deploymentId) {
    console.error(bad("No deployment id given."));
    console.error("  Take it from a failed deployment's URL on Railway:");
    console.error("    RC_SESSION='…' pnpm probe:deployment 1a2b3c4d-…\n");
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
  console.log(`Deployment: ${deploymentId}\n`);

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${session.accessToken}`,
    },
    body: JSON.stringify({
      query: DEPLOYMENT_EVENTS_QUERY,
      variables: { id: deploymentId, last: STREAM.FAILURE_EVENTS },
      operationName: "DeploymentEvents",
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
     * The code matters as much as the message. Railway answers an unauthorized field with
     * INTERNAL_SERVER_ERROR and a genuinely unknown one with GRAPHQL_VALIDATION_FAILED —
     * "the token may not read this" and "this field is gone" are opposite problems, and
     * only the second one means the app needs a code change.
     */
    console.log(
      bad(
        `${error.path?.join(".") ?? "query"} → ${error.message} ` +
          `[${error.extensions?.code ?? "no code"}]`,
      ),
    );
  }

  const nodes = (body.data?.deploymentEvents?.edges ?? []).map((edge) => edge.node);
  if (nodes.length === 0) {
    console.log(
      warn("The feed is empty. A failed row falls back to its own sentence."),
    );
    console.log(
      dim("  Try a deployment that failed recently — events are not kept forever."),
    );
    return;
  }

  console.log(
    `Events (oldest first, ${nodes.length} of at most ${STREAM.FAILURE_EVENTS})`,
  );
  for (const node of nodes) {
    console.log(`\n  step: ${node.step ?? dim("(none)")}`);
    if (!node.payload) {
      console.log(dim("  payload: null"));
      continue;
    }
    for (const [key, value] of Object.entries(node.payload)) {
      const rendered = value === null ? dim("null") : JSON.stringify(value);
      console.log(`  payload.${key}: ${rendered}`);
    }
  }

  // Which members carried anything at all — the whole question this script exists for.
  const populated = new Set<string>();
  for (const node of nodes) {
    for (const member of ["error", "reason", "detail"]) {
      const value = node.payload?.[member];
      if (typeof value === "string" && value.trim()) populated.add(member);
    }
  }

  console.log("\nText members populated");
  if (populated.size === 0) {
    console.log(warn("none — the row will name the step and nothing else"));
  } else {
    for (const member of ["error", "reason", "detail"]) {
      console.log(
        populated.has(member) ? ok(`payload.${member}`) : dim(`  payload.${member}`),
      );
    }
  }

  console.log("\nWhat the app would show");
  const picked = pickFailureReason(nodes, STREAM.FAILURE_REASON_MAX);
  if (!picked) {
    console.log(warn("nothing — the row keeps its fallback sentence"));
  } else {
    console.log(ok(`step:   ${picked.step ?? "(none)"}`));
    console.log(ok(`reason: ${picked.reason ?? "(none)"}`));
  }

  console.log(
    dim(
      "\nIf a populated member above is not the one the picker chose, reorder\n" +
        "TEXT_MEMBERS in src/lib/railway/failure-reason.ts and update README Limitations.",
    ),
  );
}

await main();
