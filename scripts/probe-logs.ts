/**
 * Settles what this app is allowed to assume about Railway's log feeds before anything is
 * built on top of them.
 *
 * The app shows a deployment's history twice over: `getLogs()` backfills on every attach,
 * and the subscription opened after it replays whatever Railway holds. Nothing cancels the
 * overlap. The design for cancelling it — src/lib/log-overlap.ts — is positional, because
 * a LogLine as this app requests it is `{ timestamp, message, severity }` and that tuple
 * is not a key. Four things that design rests on were unverified:
 *
 *   1. what arguments the two queries and the two subscriptions really take
 *   2. whether a log line carries an id or a cursor — if it does, the positional design is
 *      thrown away and both cancels key on it instead
 *   3. whether `limit` means the most recent N, and in which order they come back
 *   4. whether subscribing replays history at all, and how far back it starts
 *
 * The first two are answered by the schema this repository commits, so they are read from
 * `src/lib/railway/schema.graphql` rather than introspected — no token, no network, and
 * the same artifact codegen generates from. `pnpm verify:schema` is what keeps that file
 * honest against the live API; duplicating its job here would be a second, weaker answer
 * to a question already owned somewhere else.
 *
 * The last two are behaviour, which no schema states and which the E2E fake decides by
 * fiat, so they need a real deployment:
 *
 *   RC_SESSION="<rc_session cookie value>" pnpm probe:logs <deployment-id> [--phase build]
 *
 * It prints a decision table at the end saying which finding changes what. Two of its rows
 * stop the work entirely: a `getLogs` that answers newest-first means the pane has been
 * rendering the backfill backwards since it was written, and a `limit` that means the
 * FIRST N rather than the most recent N means STREAM.BACKFILL_LINES has been fetching the
 * opening two hundred lines of a long build and calling them recent history. Either is a
 * bigger bug than the one this probe was written for, and neither has a test anywhere.
 *
 * Uses the *session's own OAuth access token* rather than an account token, for the same
 * reason probe-deployment.ts does: those two credentials have different visibility, and
 * the question here is what the OAuth one can see.
 *
 * Read-only. Three queries and one subscription.
 *
 * It cannot call getLogs() or streamLogs(): src/lib/railway/deployment-reads.ts and
 * src/lib/railway/subscribe.ts both `import "server-only"`, which is a bare throw outside
 * a React Server Component graph, and removing that is forbidden by .ai/rules/security.md.
 * So the GraphQL *documents* are imported from operations.ts — which carries no such
 * import, and is the thing that must not drift — and the socket handshake below is a
 * deliberate second copy of the fifteen lines in subscribe.ts.
 */

import { readFileSync } from "node:fs";
import { createClient } from "graphql-ws";
import { buildSchema, getNamedType, isObjectType } from "graphql";
import WebSocket from "ws";
import { openSession } from "../src/lib/auth/session.ts";
import { SCHEMA_PATH } from "../src/lib/railway/schema-path.ts";
import {
  BUILD_LOGS_QUERY,
  BUILD_LOGS_SUBSCRIPTION,
  DEPLOYMENT_LOGS_QUERY,
  DEPLOYMENT_LOGS_SUBSCRIPTION,
} from "../src/lib/railway/operations.ts";
import {
  dropReattachOverlap,
  expectReplay,
  overlapLength,
  sameLine,
  type ReplayGuard,
} from "../src/lib/log-overlap.ts";
import { STREAM } from "../src/lib/constants.ts";
import { RAILWAY_DEFAULTS } from "../src/env.ts";
import type { LogLine } from "../src/lib/railway/types.ts";
/*
 * Helpers only, not `openProbeSession`. This script answers its schema half before asking
 * for a credential at all — see the note in `main` — so its refusals say "stopping before
 * the live half", which is a different thing from "cannot start".
 */
import { ENDPOINT, bad, dim, ok, warn } from "./probe-support.ts";

const WS_ENDPOINT = process.env.RAILWAY_WS_URL ?? RAILWAY_DEFAULTS.WS_URL;

/** How long to hold the subscription open once frames stop arriving. */
const LISTEN_MS = 8_000;
/**
 * Frames arriving within this of the first one are the replay burst rather than live
 * output. A subscription that answers with history sends it as fast as the socket will
 * carry it; a container printing a line every half second does not.
 */
const BURST_MS = 500;
/** A small limit, to be compared against a large one. */
const SMALL_LIMIT = 5;

/**
 * Names that would make a log line addressable.
 *
 * Checked rather than assumed absent, because this is the one finding that deletes
 * src/lib/log-overlap.ts outright: with a key per line, both cancels become a Set lookup
 * and two identical progress dots stop being indistinguishable.
 */
const IDENTITY = ["id", "cursor", "seq", "sequence", "offset", "uuid"];

let token = "";

async function post<T>(query: string, variables?: Record<string, unknown>) {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await response.json()) as {
    data?: T | null;
    errors?: Array<{ message: string; extensions?: { code?: string } }>;
  };
  for (const error of body.errors ?? []) {
    console.log(bad(`${error.message} [${error.extensions?.code ?? "no code"}]`));
  }
  return body.data ?? null;
}

/**
 * Steps 1 and 2, off disk: what the fields take, and what they give back.
 *
 * Reads the committed SDL rather than introspecting. It is the same artifact codegen
 * generates the operation types from, so anything printed here is what the app's documents
 * were type-checked against — and it costs no token, which means these two answers can be
 * re-read at any time without a live deployment to point at.
 */
function describeShape(field: "buildLogs" | "deploymentLogs") {
  const schema = buildSchema(readFileSync(SCHEMA_PATH, "utf8"));

  console.log("\nArguments (from the committed schema)");
  const roots = {
    Query: schema.getQueryType(),
    Subscription: schema.getSubscriptionType(),
  };
  let returned: string | null = null;

  for (const [root, type] of Object.entries(roots)) {
    const found = type?.getFields()[field];
    if (!found) {
      console.log(bad(`${root}.${field} does not exist`));
      continue;
    }
    const args = found.args.map((a) => `${a.name}: ${a.type}`).join(", ");
    console.log(ok(`${root}.${field}(${args || "none"}) → ${found.type}`));
    returned ??= getNamedType(found.type).name;
  }

  /*
   * The app sends `deploymentId`, plus `limit` on the query. Anything else above is
   * capability it is not using, and one of them bears directly on this work: the QUERY
   * takes `startDate`, so a re-attach could ask for lines since the newest one already
   * held instead of re-fetching two hundred and cancelling the overlap afterwards. The
   * SUBSCRIPTION takes no such argument, so the within-attach replay can only be guarded
   * against, never avoided.
   */
  console.log(dim("  the app sends: deploymentId, and limit on the query"));

  if (!returned) return;

  const logType = schema.getType(returned);
  console.log(`\nWhat a log line carries (${returned})`);
  if (!isObjectType(logType)) {
    console.log(bad(`${returned} is not an object type in the committed schema`));
    return;
  }

  const fields = Object.values(logType.getFields());
  for (const f of fields) console.log(`  ${f.name}: ${f.type}`);

  const identity = fields.filter((f) => IDENTITY.includes(f.name.toLowerCase()));
  console.log(
    identity.length
      ? ok(
          `carries identity: ${identity.map((f) => f.name).join(", ")} — ` +
            "the positional design is unnecessary, key on this instead",
        )
      : warn(
          "no identity field — the positional design in src/lib/log-overlap.ts stands",
        ),
  );
}

async function fetchLines(
  field: "buildLogs" | "deploymentLogs",
  id: string,
  limit: number,
) {
  const document = field === "buildLogs" ? BUILD_LOGS_QUERY : DEPLOYMENT_LOGS_QUERY;
  const data = await post<Record<string, LogLine[] | null>>(document, {
    deploymentId: id,
    limit,
  });
  return data?.[field] ?? [];
}

const clock = (line: LogLine | undefined) => line?.timestamp ?? "(none)";
const preview = (line: LogLine | undefined) =>
  line ? `${line.timestamp} ${line.message.slice(0, 60)}` : "(none)";

/** Step 3: what `limit` selects, and in what order. */
function reportOrder(small: LogLine[], large: LogLine[]) {
  console.log("\nWhat `limit` means");
  console.log(`  limit ${SMALL_LIMIT} → ${small.length} lines`);
  console.log(`  limit ${STREAM.BACKFILL_LINES} → ${large.length} lines`);
  console.log(
    small.length <= SMALL_LIMIT
      ? ok("the cap is honoured")
      : bad(`the cap is not honoured — ${small.length} lines came back`),
  );

  const stamps = large.map((l) => l.timestamp);
  const ascending = stamps.every((t, i) => i === 0 || stamps[i - 1]! <= t);
  const descending = stamps.every((t, i) => i === 0 || stamps[i - 1]! >= t);
  console.log(
    ascending
      ? ok("oldest first — which is what the pane renders")
      : descending
        ? bad(
            "NEWEST FIRST — the pane has been rendering the backfill backwards. STOP.",
          )
        : bad("unordered — the pane cannot render this as a transcript. STOP."),
  );

  if (small.length === 0 || large.length === 0) return;
  const head = small.every((line, i) => large[i] && sameLine(large[i]!, line));
  const tailStart = large.length - small.length;
  const tail = small.every(
    (line, i) => large[tailStart + i] && sameLine(large[tailStart + i]!, line),
  );
  console.log(
    tail
      ? ok("the small result is the TAIL of the large one — limit means most-recent-N")
      : head
        ? bad(
            "the small result is the HEAD of the large one — limit means FIRST-N. STOP.",
          )
        : warn("the small result is neither the head nor the tail of the large one"),
  );

  // Real-world evidence for the constraint the whole design rests on.
  let adjacent = 0;
  for (let i = 1; i < large.length; i++) {
    if (sameLine(large[i - 1]!, large[i]!)) adjacent += 1;
  }
  console.log(
    adjacent > 0
      ? ok(
          `${adjacent} adjacent line(s) are identical in (timestamp, message, severity) — ` +
            "a key-based dedup would have deleted them",
        )
      : dim("  no two adjacent lines are identical in this deployment"),
  );
}

/** Step 4: does subscribing replay history, and how far back does it start. */
async function listen(field: "buildLogs" | "deploymentLogs", id: string) {
  const document =
    field === "buildLogs" ? BUILD_LOGS_SUBSCRIPTION : DEPLOYMENT_LOGS_SUBSCRIPTION;

  const authed = class extends WebSocket {
    constructor(address: string | URL, protocols?: string | string[]) {
      super(address, protocols, { headers: { Authorization: `Bearer ${token}` } });
    }
  } as unknown as typeof WebSocket;

  const client = createClient({
    url: WS_ENDPOINT,
    webSocketImpl: authed,
    connectionParams: { Authorization: `Bearer ${token}` },
    retryAttempts: 0,
  });

  const burst: LogLine[] = [];
  const live: LogLine[] = [];
  let first = 0;

  await new Promise<void>((resolve) => {
    let idle: NodeJS.Timeout | undefined;
    const done = () => {
      dispose();
      resolve();
    };
    const bump = () => {
      clearTimeout(idle);
      idle = setTimeout(done, LISTEN_MS);
    };

    const dispose = client.subscribe<Record<string, LogLine[] | LogLine | null>>(
      { query: document, variables: { deploymentId: id } },
      {
        next: (result) => {
          const payload = result.data?.[field];
          if (!payload) return;
          const at = Date.now();
          first ||= at;
          for (const line of Array.isArray(payload) ? payload : [payload]) {
            (at - first <= BURST_MS ? burst : live).push(line);
          }
          bump();
        },
        error: (error) => {
          console.log(bad(`subscription error: ${String(error)}`));
          resolve();
        },
        complete: done,
      },
    );
    bump();
  });

  await client.dispose();
  return { burst, live };
}

async function main() {
  const cookie = process.env.RC_SESSION;
  const secret = process.env.SESSION_SECRET;
  /*
   * The id is the first argument that is neither a flag nor a flag's value. Reading
   * argv[2] positionally was enough while an id was mandatory; now that the schema half
   * runs without one, `pnpm probe:logs --phase build` would otherwise report its own flag
   * as the deployment it was about to read.
   */
  const args = process.argv.slice(2);
  const phaseFlag = args.indexOf("--phase");
  const phase = phaseFlag === -1 ? "deploy" : args[phaseFlag + 1];
  const deploymentId = args.find(
    (arg, index) => !arg.startsWith("--") && index !== phaseFlag + 1,
  );

  if (phase !== "build" && phase !== "deploy") {
    console.error(bad(`--phase must be build or deploy, not ${String(phase)}`));
    process.exit(1);
  }

  const field = phase === "build" ? "buildLogs" : "deploymentLogs";

  console.log(`\nEndpoint:   ${ENDPOINT}`);
  console.log(`Socket:     ${WS_ENDPOINT}`);
  console.log(`Deployment: ${deploymentId ?? dim("(none given)")}`);
  console.log(`Field:      ${field}`);

  /*
   * The schema half runs before anything is required of the caller, because it needs
   * nothing from them: no token, no deployment, no network. A stale cookie or a deployment
   * whose logs have aged out should not be able to withhold the two answers that are
   * already sitting in the repository.
   */
  describeShape(field);

  if (!secret) {
    console.error(bad("SESSION_SECRET is not set — stopping before the live half."));
    console.error("  Run through the package script, which loads .env:");
    console.error("    RC_SESSION=… pnpm probe:logs <deployment-id>\n");
    process.exit(1);
  }
  if (!cookie) {
    console.error(bad("RC_SESSION is not set — stopping before the live half."));
    console.error("  Sign in, then copy the `rc_session` cookie value:");
    console.error("    DevTools → Application → Cookies → rc_session\n");
    console.error("    RC_SESSION='<value>' pnpm probe:logs <deployment-id>\n");
    process.exit(1);
  }
  if (!deploymentId) {
    console.error(bad("No deployment id given — stopping before the live half."));
    console.error("  Take it from a deployment's URL on Railway. A build with a few");
    console.error("  hundred lines of output says more than a quiet one:\n");
    console.error("    RC_SESSION='…' pnpm probe:logs 1a2b3c4d-… --phase build\n");
    process.exit(1);
  }

  const session = await openSession(cookie, secret);
  if (!session) {
    console.error(
      bad("Could not open that session — wrong SESSION_SECRET, or the cookie expired."),
    );
    process.exit(1);
  }
  token = session.accessToken;

  const small = await fetchLines(field, deploymentId, SMALL_LIMIT);
  const backfill = await fetchLines(field, deploymentId, STREAM.BACKFILL_LINES);
  reportOrder(small, backfill);

  if (backfill.length === 0) {
    console.log(
      warn("\nThis deployment has no readable history — the rest says nothing."),
    );
    console.log(dim("  Try a deployment that produced output, and the other --phase."));
    return;
  }

  /*
   * Step 5a: what a SECOND attach would do. This is the overlap that exists whatever
   * Railway's subscription does — a phase re-dial or a dropped EventSource re-runs exactly
   * this query and the client appends the answer.
   */
  const again = await fetchLines(field, deploymentId, STREAM.BACKFILL_LINES);
  const stacked = [...backfill, ...again];
  const merged = dropReattachOverlap(stacked, again.length);
  console.log("\nWhat a re-attach costs today");
  console.log(`  buffer after two attaches, uncancelled: ${stacked.length} lines`);
  console.log(
    merged.length === backfill.length
      ? ok(`cancelled to ${merged.length} — the second attach added nothing new`)
      : ok(
          `cancelled to ${merged.length} — ${merged.length - backfill.length} genuinely new`,
        ),
  );
  if (merged.length === stacked.length) {
    console.log(
      warn(
        "nothing cancelled: the two queries returned disjoint windows, which is odd",
      ),
    );
  }

  // Step 5b: what the subscription does on top of it.
  console.log(dim(`\nListening for up to ${LISTEN_MS / 1000}s of quiet…`));
  const { burst, live } = await listen(field, deploymentId);
  console.log(`\nSubscription`);
  console.log(`  burst (first ${BURST_MS}ms): ${burst.length} lines`);
  console.log(`  live afterwards:          ${live.length} lines`);
  console.log(dim(`  burst oldest: ${preview(burst[0])}`));
  console.log(dim(`  burst newest: ${preview(burst.at(-1))}`));
  console.log(dim(`  backfill newest: ${preview(backfill.at(-1))}`));

  if (burst.length === 0) {
    console.log(ok("no replay — the subscription sends only new lines"));
  } else {
    const k = overlapLength(backfill, burst);
    console.log(
      k > 0
        ? bad(`the burst repeats ${k} line(s) the backfill already showed`)
        : warn(
            "the burst shares no run with the backfill — inspect the timestamps above",
          ),
    );

    const older = burst.filter((l) => l.timestamp < clock(backfill[0])).length;
    console.log(
      older > 0
        ? warn(
            `${older} replayed line(s) predate the backfill — set STREAM.REPLAY_SCAN_LINES ` +
              `above ${older}`,
          )
        : ok("the replay starts no earlier than the backfill — REPLAY_SCAN_LINES: 1"),
    );

    const guard: ReplayGuard = expectReplay(backfill, Math.max(older + 1, 1));
    const suppressed = burst.filter((l) => guard(l)).length;
    console.log(
      `  expectReplay would suppress ${suppressed} of ${burst.length} replayed line(s)`,
    );
  }

  console.log(`
${dim("Decision table — what each finding changes")}

  ${dim("Settled by the schema above, before this ran:")}
  identity on the line         none in the committed schema, so both cancels stay
                               positional. If one ever appears, throw log-overlap.ts away
                               and key on it — that is strictly better.
  startDate on the query       exists, and only on the QUERY. A re-attach could fetch from
                               the newest line it holds rather than cancelling afterwards.
                               The subscription has no such argument, so the within-attach
                               replay can only ever be guarded against.

  ${dim("Settled by the run above:")}
  no replay observed           keep the guard at REPLAY_SCAN_LINES: 1 — createLogClient
                               retries the socket, and a re-subscribe is a replay
  replay predates backfill     set REPLAY_SCAN_LINES from the count above, with headroom
  a re-attach cancels to ~200  Overlap 2 is real; dropReattachOverlap on \`ready\` is the fix
  newest-first, or first-N     STOP — the backfill is wrong before any of this matters
`);
}

main().catch((error: unknown) => {
  console.error(bad(`probe crashed: ${String(error)}`));
  process.exit(1);
});
