/**
 * Settles whether Railway lets a client subscribe to a deployment's status.
 *
 * Three ADRs and `src/lib/constants.ts` state that it does not — "Railway exposes log
 * subscriptions but no deployment-status subscription, so status is polled" — and that
 * claim is the premise under `/api/watch`, under STREAM's whole polling ladder, and under
 * ADR-3's and ADR-10's cost arithmetic.
 *
 * The committed schema disagrees. `Subscription.deployment(id: String!): Deployment!` is
 * documented "Subscribe to updates for a specific deployment", and `Deployment.status` is
 * non-null. So the field exists. What introspection cannot say is whether a **delegated
 * OAuth grant** may open it — that is a different question from what the schema declares,
 * and it is the same distinction `probe:metrics` exists for.
 *
 *   RC_SESSION="<rc_session cookie value>" pnpm probe:subscription [deployment-id]
 *   RAILWAY_TOKEN=… pnpm probe:subscription [deployment-id]
 *
 * Prefer RC_SESSION. It carries the session's own OAuth access token, which is the
 * credential the app actually holds, and it is the only one that answers the question the
 * ADRs need answered. RAILWAY_TOKEN is an account token with different visibility: it can
 * only prove that the capability exists and functions, not that this app could use it.
 * The verdict at the end says which of the two ran and what that does and does not settle.
 *
 * Read-only. One query to find a deployment if none is given, then one subscription that
 * is closed as soon as it answers.
 *
 * It cannot call the app's own `subscribe.ts`: that module imports `server-only`, which is
 * a bare throw outside a React Server Component graph. So the socket handshake below is a
 * deliberate second copy of the fifteen lines in it, exactly as `probe-logs.ts` explains
 * for the same reason. The *documents* are imported rather than restated.
 */

import { createClient } from "graphql-ws";
import WebSocket from "ws";
import { openSession } from "../src/lib/auth/session.ts";
import {
  PROJECTS_PERSONAL_QUERY,
  PROJECT_QUERY,
} from "../src/lib/railway/operations.ts";
import { RAILWAY_DEFAULTS } from "../src/env.ts";

const ENDPOINT = process.env.RAILWAY_API_URL ?? RAILWAY_DEFAULTS.API_URL;
const WS_ENDPOINT = process.env.RAILWAY_WS_URL ?? RAILWAY_DEFAULTS.WS_URL;

const ok = (s: string) => `\x1b[32m✓\x1b[0m ${s}`;
const bad = (s: string) => `\x1b[31m✗\x1b[0m ${s}`;
const warn = (s: string) => `\x1b[33m!\x1b[0m ${s}`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

/** How long to wait for the first push before calling it silence. */
const FIRST_MESSAGE_TIMEOUT_MS = 15_000;

type Credential = { token: string; kind: "oauth" | "account" };

async function credential(): Promise<Credential> {
  const cookie = process.env.RC_SESSION;
  const secret = process.env.SESSION_SECRET;

  if (cookie) {
    if (!secret) {
      throw new Error("RC_SESSION is set but SESSION_SECRET is not; cannot open it.");
    }
    const session = await openSession(cookie, secret);
    if (!session)
      throw new Error("RC_SESSION could not be opened with SESSION_SECRET.");
    return { token: session.accessToken, kind: "oauth" };
  }

  const account = process.env.RAILWAY_TOKEN;
  if (account) return { token: account, kind: "account" };

  throw new Error("Set RC_SESSION (preferred) or RAILWAY_TOKEN.");
}

async function query<T>(
  token: string,
  document: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query: document, variables }),
  });
  const body = (await response.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };
  if (body.errors?.length) {
    throw new Error(body.errors.map((error) => error.message).join("; "));
  }
  if (!body.data) throw new Error(`no data (HTTP ${response.status})`);
  return body.data;
}

/**
 * A syntactically valid id that names nothing, for when no real deployment is reachable.
 *
 * Enough to settle the question this probe exists for. GraphQL validates a document
 * against the schema before it resolves anything, so a `Subscription` with no `deployment`
 * field answers "Cannot query field ... on type Subscription" whatever id is passed —
 * while a schema that *has* the field gets far enough to refuse on authorization or on the
 * id not existing. Those two answers are distinguishable, and only the first would support
 * what the ADRs claim.
 */
const NONEXISTENT_DEPLOYMENT = "00000000-0000-4000-8000-000000000000";

/** Any deployment the credential can see, so the probe needs no argument. */
async function findDeployment(token: string): Promise<string | null> {
  type Projects = {
    me?: { projects?: { edges?: Array<{ node: { id: string; name: string } }> } };
  };
  const projects = await query<Projects>(token, PROJECTS_PERSONAL_QUERY, {});
  const nodes = projects.me?.projects?.edges?.map((edge) => edge.node) ?? [];

  for (const project of nodes) {
    type One = {
      project?: {
        services?: {
          edges?: Array<{
            node: {
              name: string;
              serviceInstances?: {
                edges?: Array<{ node: { latestDeployment?: { id: string } | null } }>;
              };
            };
          }>;
        };
      };
    };
    const detail = await query<One>(token, PROJECT_QUERY, { id: project.id });
    for (const service of detail.project?.services?.edges ?? []) {
      for (const instance of service.node.serviceInstances?.edges ?? []) {
        const id = instance.node.latestDeployment?.id;
        if (id) {
          console.log(
            dim(`  using ${service.node.name} in ${project.name} — deployment ${id}`),
          );
          return id;
        }
      }
    }
  }
  return null;
}

/**
 * The result of opening the subscription, which is the whole point of this file.
 *
 * `refused` is the interesting one: a schema that declares the field and a server that
 * refuses to open it for this credential is exactly the shape the ADRs would need in order
 * to be right for a reason other than the one they give.
 */
type Outcome =
  | { kind: "pushed"; payload: unknown }
  | { kind: "silent" }
  | { kind: "refused"; reason: string };

const STATUS_SUBSCRIPTION = /* GraphQL */ `
  subscription ProbeDeploymentStatus($id: String!) {
    deployment(id: $id) {
      id
      status
    }
  }
`;

async function subscribe(
  token: string,
  deploymentId: string,
  document: string = STATUS_SUBSCRIPTION,
): Promise<Outcome> {
  const authed = class extends WebSocket {
    constructor(address: string | URL, protocols?: string | string[]) {
      super(address, protocols, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }
  } as unknown as typeof WebSocket;

  const client = createClient({
    url: WS_ENDPOINT,
    webSocketImpl: authed,
    connectionParams: { Authorization: `Bearer ${token}` },
    retryAttempts: 0,
  });

  try {
    return await new Promise<Outcome>((resolve) => {
      const timer = setTimeout(
        () => resolve({ kind: "silent" }),
        FIRST_MESSAGE_TIMEOUT_MS,
      );
      const settle = (outcome: Outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      };

      client.subscribe(
        { query: document, variables: { id: deploymentId } },
        {
          next: (value) => settle({ kind: "pushed", payload: value }),
          error: (error) =>
            settle({
              kind: "refused",
              reason:
                error instanceof Error
                  ? error.message
                  : Array.isArray(error)
                    ? error.map((e) => String((e as Error).message)).join("; ")
                    : JSON.stringify(error),
            }),
          complete: () => settle({ kind: "silent" }),
        },
      );
    });
  } finally {
    await client.dispose();
  }
}

async function main() {
  const { token, kind } = await credential();
  console.log(
    `\nCredential: ${kind === "oauth" ? "the session's OAuth access token" : "an account token (RAILWAY_TOKEN)"}`,
  );

  const given = process.argv[2];
  let deploymentId = given;
  let real = Boolean(given);

  if (!deploymentId) {
    // Not fatal when it fails. An account token is refused `me { projects }` outright —
    // "Not Authorized", which is the shape README's "Known non-issues" describes — and the
    // existence question can still be answered without a real id. See NONEXISTENT_DEPLOYMENT.
    const found = await findDeployment(token).catch((error: unknown) => {
      console.log(
        dim(
          `  could not list deployments (${error instanceof Error ? error.message : String(error)})`,
        ),
      );
      return null;
    });
    deploymentId = found ?? NONEXISTENT_DEPLOYMENT;
    real = Boolean(found);
  }

  if (!real) {
    console.log(
      dim(
        "  probing with an id that names nothing — enough to tell absent from refused",
      ),
    );
  }

  /*
   * The control, and it is not optional.
   *
   * "The server did not reject it" only means something if the server rejects things. A
   * silent accept and a server that ignores unknown fields are the same observation from
   * here, and the second would make every run of this probe report a capability that does
   * not exist. So a field that certainly does not exist is subscribed to first, and the
   * probe refuses to draw any conclusion unless that one is refused by name.
   */
  console.log("\nControl");
  const control = await subscribe(
    token,
    deploymentId,
    /* GraphQL */ `
      subscription ProbeControl($id: String!) {
        definitelyNotAField(id: $id) {
          id
        }
      }
    `,
  );
  const rejectsUnknownFields =
    control.kind === "refused" && /cannot query field/i.test(control.reason);

  if (rejectsUnknownFields) {
    console.log(ok("the server rejects an unknown subscription field, as it should"));
    console.log(dim(`  ${control.reason}`));
  } else {
    console.log(bad("the server did NOT reject a field that does not exist"));
    console.log(
      dim("  Nothing below can be trusted: silence here does not mean acceptance."),
    );
    console.log();
    process.exit(1);
  }

  console.log("\nSubscription.deployment");
  const outcome = await subscribe(token, deploymentId);

  if (outcome.kind === "pushed") {
    console.log(ok("the server accepted the subscription and pushed"));
    console.log(dim(`  ${JSON.stringify(outcome.payload)}`));
  } else if (outcome.kind === "silent") {
    console.log(
      ok("the server accepted the subscription; nothing pushed before the timeout"),
    );
    console.log(
      dim(
        "  Expected on an idle deployment — it publishes on change, and nothing changed.",
      ),
    );
  } else {
    console.log(bad("the server refused the subscription"));
    console.log(dim(`  ${outcome.reason}`));
  }

  console.log("\nWhat this settles");

  /*
   * The one answer that would vindicate the ADRs: the server rejecting the *document*
   * because `Subscription` has no such field. Matched on the phrasing GraphQL's own
   * validator uses, which is stable across servers.
   */
  const fieldAbsent =
    outcome.kind === "refused" &&
    /cannot query field .?deployment.? on type .?Subscription/i.test(outcome.reason);

  if (fieldAbsent) {
    console.log(ok("The schema has no Subscription.deployment. The ADRs are correct."));
    console.log("  Nothing to change — but the committed schema.graphql disagrees, so");
    console.log("  re-run `pnpm schema:pull`: the artifact is stale.");
    console.log();
    return;
  }

  if (!real) {
    console.log(
      ok(
        "Subscription.deployment exists — the server validated the document against it.",
      ),
    );
    console.log(
      '  So "Railway exposes no deployment-status subscription" is false as a',
    );
    console.log(
      "  flat claim, whatever this credential is allowed to open — the control",
    );
    console.log("  above shows the server rejects a field it does not have, and it");
    console.log("  did not reject this one.");
    console.log(
      warn("  Whether this app's OAuth grant may open it is still open. Re-run with"),
    );
    console.log("  RC_SESSION and a real deployment id to settle that half.");
    console.log();
    return;
  }

  const accepted = outcome.kind !== "refused";
  if (accepted && kind === "oauth") {
    console.log(
      ok(
        "An OAuth grant may subscribe to deployment status. The ADRs' premise is wrong.",
      ),
    );
    console.log(
      "  Polling may still be the right design — a second upstream socket per",
    );
    console.log(
      "  stream is a real cost against STREAM.MAX_CONCURRENT_PER_USER — but it",
    );
    console.log("  is a decision with a price, not an absence. Say so in ADR-3.");
  } else if (accepted) {
    console.log(
      warn("The capability exists and functions, on an ACCOUNT token. That refutes"),
    );
    console.log(
      '  "Railway exposes no deployment-status subscription" as a flat claim.',
    );
    console.log("  It does NOT establish that this app's OAuth grant may open it — an");
    console.log(
      "  account token has wider visibility. Re-run with RC_SESSION to settle",
    );
    console.log("  that half.");
  } else if (kind === "oauth") {
    console.log(
      warn("The field exists in the schema but this OAuth grant cannot open it."),
    );
    console.log(
      "  The ADRs reach the right conclusion by the wrong route: reword them to",
    );
    console.log(
      "  say the grant cannot reach it, and keep this output as the evidence.",
    );
  } else {
    console.log(warn("Refused for an account token, which settles little on its own."));
    console.log("  Re-run with RC_SESSION before concluding anything.");
  }
  console.log();
}

main().catch((error: unknown) => {
  console.error(
    bad(`\nprobe failed: ${error instanceof Error ? error.message : String(error)}\n`),
  );
  process.exit(1);
});
