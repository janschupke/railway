/**
 * What Railway will actually tell this app about usage and spend.
 *
 * Introspection answers what the schema *declares*; it says nothing about what an OAuth
 * token holding `project:admin` and `workspace:viewer` is permitted to read. Those are
 * different questions, and Railway answers a refused field with HTTP 200 and a nulled
 * field rather than an error status — so the only way to know is to ask.
 *
 *   RC_SESSION="<rc_session cookie value>" pnpm probe:metrics <projectId> <environmentId>
 *
 * Like probe-projects, it deliberately uses the *session's own OAuth access token* rather
 * than an account token from railway.com/account/tokens. Those two credentials have
 * different visibility, and an account token would answer a question nobody asked.
 *
 * Read-only: every query below is a query, never a mutation.
 *
 * The four things it exists to settle, because the metrics feature is designed around the
 * answers:
 *
 *   1. Whether `metrics` is readable at all. If it is not, the readout is dead and the
 *      whole per-row half of T-492 is a `note` on an OPTIONAL_FIELDS entry.
 *   2. Which CPU member carries data. `CPU_USAGE` and `CPU_USAGE_2` both exist and Railway
 *      documents neither; only a live response can say which one is populated.
 *   3. Whether `environmentId` alongside `projectId` actually narrows. If it does not, the
 *      mapper has to group by `[SERVICE_ID, ENVIRONMENT_ID]` and filter — one more branch,
 *      no more requests.
 *   4. Whether the `project.workspace.customer` chain answers. That chain is the only
 *      monetary figure anywhere in Railway's schema, and it is three types below a root
 *      field where `verify:schema` cannot see it.
 */

import { openSession } from "../src/lib/auth/session.ts";
import { RAILWAY_DEFAULTS } from "../src/env.ts";

const ENDPOINT = process.env.RAILWAY_API_URL ?? RAILWAY_DEFAULTS.API_URL;

const ok = (s: string) => `\x1b[32m✓\x1b[0m ${s}`;
const bad = (s: string) => `\x1b[31m✗\x1b[0m ${s}`;
const warn = (s: string) => `\x1b[33m!\x1b[0m ${s}`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

type GraphQLBody = {
  data?: unknown;
  errors?: Array<{
    message: string;
    path?: Array<string | number>;
    extensions?: { code?: string };
  }>;
};

async function run(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<GraphQLBody> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  try {
    return (await response.json()) as GraphQLBody;
  } catch {
    return { errors: [{ message: `non-JSON response (HTTP ${response.status})` }] };
  }
}

/**
 * The window every metrics source below reads.
 *
 * Five minutes because a container started moments ago must have produced at least one
 * sample inside it, and because a probe that reads an hour of history would report a
 * response size the app is never going to ask for.
 */
const WINDOW_MS = 5 * 60 * 1000;

const METRICS = `query ProbeMetrics(
  $projectId: String!
  $environmentId: String
  $measurements: [MetricMeasurement!]!
  $startDate: DateTime!
  $groupBy: [MetricTag!]
) {
  metrics(
    projectId: $projectId
    environmentId: $environmentId
    measurements: $measurements
    startDate: $startDate
    groupBy: $groupBy
    sampleRateSeconds: 60
    averagingWindowSeconds: 60
  ) {
    measurement
    tags { serviceId environmentId }
    values { ts value }
  }
}`;

/**
 * The whole spend chain in one document, on purpose.
 *
 * Split into four probes, a refusal would only say that the outermost one failed. Asked
 * together, `errors[].path` names the exact link that broke — `["project","workspace"]` and
 * `["project","workspace","customer","currentUsage"]` are different problems with different
 * answers, and the difference decides whether the feature shows a figure or a link.
 */
const SPEND = `query ProbeSpend($projectId: String!) {
  project(id: $projectId) {
    id
    name
    workspace {
      id
      name
      apiTokenRateLimit { remainingPoints resetsAt }
      customer {
        currentUsage
        billingPeriod { start end }
        usageLimit { softLimit hardLimit isOverLimit }
      }
    }
  }
}`;

const ESTIMATED = `query ProbeEstimatedUsage(
  $projectId: String!
  $measurements: [MetricMeasurement!]!
) {
  estimatedUsage(projectId: $projectId, measurements: $measurements) {
    estimatedValue
    measurement
    projectId
  }
}`;

function sources(projectId: string, environmentId: string) {
  const startDate = new Date(Date.now() - WINDOW_MS).toISOString();
  const base = { projectId, environmentId, startDate, groupBy: ["SERVICE_ID"] };

  return [
    {
      name: "me (identity only — is the token usable at all?)",
      query: `query { me { id } }`,
      variables: {},
    },
    {
      name: "metrics CPU_USAGE + MEMORY_USAGE_GB (the document the app will send)",
      query: METRICS,
      variables: { ...base, measurements: ["CPU_USAGE", "MEMORY_USAGE_GB"] },
    },
    {
      // Two CPU members exist and Railway documents neither. Whichever comes back with a
      // non-empty `values` array is the one the app must send.
      name: "metrics CPU_USAGE_2 (which CPU member is populated?)",
      query: METRICS,
      variables: { ...base, measurements: ["CPU_USAGE_2"] },
    },
    {
      // Free if populated — same request, two more members — and it is the difference
      // between "0.3 vCPU" and "0.3 of 2 vCPU", which is the version that means something.
      name: "metrics CPU_LIMIT + MEMORY_LIMIT_GB (is a denominator available?)",
      query: METRICS,
      variables: { ...base, measurements: ["CPU_LIMIT", "MEMORY_LIMIT_GB"] },
    },
    {
      // If the environment filter is ignored, this returns the same rows as the source
      // above and the mapper has to narrow on tags.environmentId itself.
      name: "metrics without environmentId, grouped by SERVICE_ID + ENVIRONMENT_ID (does the filter narrow?)",
      query: METRICS,
      variables: {
        ...base,
        environmentId: null,
        groupBy: ["SERVICE_ID", "ENVIRONMENT_ID"],
        measurements: ["CPU_USAGE", "MEMORY_USAGE_GB"],
      },
    },
    {
      // Printed so its uselessness for cost is on the record rather than re-derived: this
      // returns GB and vCPU, not money. There is no dollar measurement in the enum.
      name: "estimatedUsage (magnitudes, NOT money — printed so nobody re-derives that)",
      query: ESTIMATED,
      variables: { projectId, measurements: ["CPU_USAGE", "MEMORY_USAGE_GB"] },
    },
    {
      name: "project.workspace.customer (the only monetary figure in the schema)",
      query: SPEND,
      variables: { projectId },
    },
  ];
}

/** Field names on a type, so the shape is read rather than assumed. */
const TYPE_FIELDS = `query TypeFields($name: String!) {
  __type(name: $name) { name kind fields { name } enumValues { name } }
}`;

async function introspectType(token: string, name: string) {
  const body = (await run(token, TYPE_FIELDS, { name })) as {
    data?: {
      __type?: {
        kind: string;
        fields?: Array<{ name: string }> | null;
        enumValues?: Array<{ name: string }> | null;
      } | null;
    };
    errors?: Array<{ message: string }>;
  };

  const [error] = body.errors ?? [];
  if (error) {
    console.log(warn(`introspection of ${name} rejected: ${error.message}`));
    return;
  }
  const type = body.data?.__type;
  if (!type) {
    console.log(warn(`type ${name} not found`));
    return;
  }
  const members = type.fields ?? type.enumValues ?? [];
  console.log(ok(`${name} (${type.kind}): ${members.map((f) => f.name).join(", ")}`));
}

async function main() {
  const cookie = process.env.RC_SESSION;
  const secret = process.env.SESSION_SECRET;
  const [projectId, environmentId] = process.argv.slice(2);

  if (!secret) {
    console.error(bad("SESSION_SECRET is not set."));
    console.error("  Run through the package script, which loads .env:");
    console.error("    RC_SESSION=… pnpm probe:metrics <projectId> <environmentId>\n");
    process.exit(1);
  }
  if (!cookie) {
    console.error(bad("RC_SESSION is not set."));
    console.error("  Sign in, then copy the `rc_session` cookie value:");
    console.error("    DevTools → Application → Cookies → rc_session\n");
    console.error(
      "    RC_SESSION='<value>' pnpm probe:metrics <projectId> <environmentId>\n",
    );
    process.exit(1);
  }
  if (!projectId || !environmentId) {
    console.error(bad("A project id and an environment id are required."));
    console.error(
      "  Both are in the dashboard URL: /dashboard?project=…&environment=…",
    );
    console.error("  Or run `pnpm probe:projects` first, which prints them.\n");
    console.error(
      "    RC_SESSION='<value>' pnpm probe:metrics <projectId> <environmentId>\n",
    );
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
  console.log(`Project:  ${projectId}`);
  console.log(`Env:      ${environmentId}`);

  console.log("\nSession");
  console.log(ok(`viewer ${session.user.id} ${dim(session.user.email ?? "")}`));
  console.log(dim(`  scope: ${session.scope}`));

  console.log("\nSources");
  for (const source of sources(projectId, environmentId)) {
    const body = await run(session.accessToken, source.query, source.variables);

    for (const error of body.errors ?? []) {
      /*
       * The code and the path matter as much as the message. Railway answers an
       * unauthorized field with INTERNAL_SERVER_ERROR and a genuinely unknown one with
       * GRAPHQL_VALIDATION_FAILED — opposite problems, and the path is what attributes a
       * refusal inside the nested spend chain to the link that actually broke.
       */
      console.log(
        bad(
          `${source.name} → ${error.message} ` +
            `[${error.extensions?.code ?? "no code"}] ` +
            `at ${error.path?.join(".") ?? "(no path)"}`,
        ),
      );
    }

    if (!body.errors?.length) console.log(ok(source.name));

    /*
     * Printed raw and whole, alongside any errors, because partial data is the interesting
     * case: a refused field nulls itself and the rest still resolves, which is exactly what
     * gqlPartial keeps and what a pass/fail line cannot show. An empty array and a null
     * field also look identical in a count, and telling those apart is half the point.
     */
    if (body.data) console.log(dim(`  ${JSON.stringify(body.data)}`));
  }

  console.log("\nSchema shape");
  await introspectType(session.accessToken, "MetricsResult");
  await introspectType(session.accessToken, "MetricTags");
  await introspectType(session.accessToken, "MetricMeasurement");
  await introspectType(session.accessToken, "Customer");

  console.log(
    `\n${warn("Read the raw payloads above before changing the query — that is what this is for.")}\n`,
  );
}

main().catch((error) => {
  console.error(bad(`probe crashed: ${String(error)}`));
  process.exit(1);
});
