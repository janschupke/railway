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
 * The four things it exists to settle, with what one run against a `project:admin` +
 * `workspace:viewer` session answered. Three are closed; nothing here needs re-running to
 * learn them again, and every source below is kept precisely so the fourth can be asked in
 * the same context the first three were.
 *
 *   1. Whether `metrics` is readable at all. If it were not, the readout would be dead and
 *      the whole per-row half of T-492 a `note` on an OPTIONAL_FIELDS entry.
 *      **Answered: readable.** Five points per series over a five-minute window at
 *      `sampleRateSeconds: 60`, which is what the METRICS constants are sized to. Railway
 *      also returns one aggregate result per measurement carrying `tags.serviceId: null`,
 *      which `toContainerMetrics` drops.
 *   2. Which CPU member carries data. `CPU_USAGE` and `CPU_USAGE_2` both exist and Railway
 *      documents neither; only a live response can say which one is populated.
 *      **Answered: `CPU_USAGE`.** `CPU_USAGE_2` returned an empty array.
 *      `CPU_LIMIT` and `MEMORY_LIMIT_GB` came back populated in the same request — which is
 *      what each row's "0.25 of 2 vCPU" is built on — at 2 and 0.99999744 respectively.
 *   3. Whether `environmentId` alongside `projectId` actually narrows. If it does not, the
 *      mapper has to group by `[SERVICE_ID, ENVIRONMENT_ID]` and filter — one more branch,
 *      no more requests.
 *      **Still open.** The project probed has services in one environment only, so both
 *      shapes returned the same rows and proved nothing. Ask this against a project with two
 *      populated environments.
 *   4. Whether the `project.workspace.customer` chain answers. That chain is the only
 *      monetary figure anywhere in Railway's schema. `verify:schema` does now validate it —
 *      the document selecting it is in `operations.ts` and is checked like any other — so
 *      what is left for this probe is the question introspection cannot answer: whether an
 *      OAuth grant is *permitted* to read it. Different question, same script.
 *      **Answered: it does**, with `currentUsage` and a `billingPeriod`. `estimatedUsage`
 *      answered too, in GB and vCPU — magnitudes, not money, which is why the dashboard's
 *      only dollar figure is workspace-wide.
 *
 * The answers hold for one token on one plan. That is this file's own premise — introspection
 * cannot tell you what a grant may read — so they are recorded rather than treated as
 * permanent, and re-running against a different plan is a reasonable thing to do.
 */

import {
  ENDPOINT,
  bad,
  dim,
  ok,
  openProbeSession,
  postGraphQL,
  warn,
} from "./probe-support.ts";

const USAGE = "RC_SESSION='<value>' pnpm probe:metrics <projectId> <environmentId>";

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
  const body = (await postGraphQL(token, TYPE_FIELDS, { name })) as {
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
  const [projectId, environmentId] = process.argv.slice(2);

  if (!projectId || !environmentId) {
    console.error(bad("A project id and an environment id are required."));
    console.error(
      "  Both are in the dashboard URL: /dashboard?project=…&environment=…",
    );
    console.error("  Or run `pnpm probe:projects` first, which prints them.\n");
    console.error(`    ${USAGE}\n`);
    process.exit(1);
  }

  const session = await openProbeSession(USAGE);

  console.log(`\nEndpoint: ${ENDPOINT}`);
  console.log(`Project:  ${projectId}`);
  console.log(`Env:      ${environmentId}`);

  console.log("\nSession");
  console.log(ok(`viewer ${session.user.id} ${dim(session.user.email ?? "")}`));
  console.log(dim(`  scope: ${session.scope}`));

  console.log("\nSources");
  for (const source of sources(projectId, environmentId)) {
    const body = await postGraphQL(session.accessToken, source.query, source.variables);

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
