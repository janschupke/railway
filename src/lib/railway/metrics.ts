/**
 * What a project is using, and what its workspace is being charged.
 *
 * One document behind both, because they are read together on every dashboard render and
 * Railway will answer with whichever half the token reaches. That is why this is the module
 * most likely to be partially refused, and why it degrades rather than throwing.
 */

import "server-only";

import { METRICS } from "@/lib/constants";
import { gqlPartial, logRefusals } from "./client";
import { PROJECT_METRICS_QUERY } from "./operations";
import { toContainerMetrics, toWorkspaceSpend } from "./mappers";
import type { ContainerMetrics, WorkspaceSpend } from "./types";

/**
 * What the containers in one environment are using, and what the workspace has spent.
 *
 * `gqlPartial` rather than `gql`, and unlike everywhere else in this file that is the whole
 * design rather than a detail. Both halves of this document are things a given token may not
 * be permitted to read — `metrics` needs the project scope, `customer` needs the workspace
 * one — and Railway refuses a field with HTTP 200, an `errors[]` entry and the field nulled.
 * `gql` throws on that and would discard the half that did arrive.
 *
 * So this never throws for a refusal: it returns `{}` and `null`, and the dashboard renders
 * exactly what it rendered before this feature existed. Transport, rate-limit and 5xx
 * failures still throw, because `execute` throws before this returns, and the loader's catch
 * is where that is spelled out.
 *
 * One request per environment, not one per row — see PROJECT_METRICS_QUERY on why the
 * grouping matters to ADR-10's budget.
 */
export async function getProjectMetrics(
  accessToken: string,
  projectId: string,
  environmentId: string,
  signal?: AbortSignal,
): Promise<{
  metrics: Record<string, ContainerMetrics>;
  spend: WorkspaceSpend | null;
}> {
  const { data, errors } = await gqlPartial(
    PROJECT_METRICS_QUERY,
    {
      projectId,
      environmentId,
      /*
       * Four measurements, one request. `measurements` is a query variable, so the two
       * ceilings cost no second round trip and no change to the document — which is what
       * makes the denominator on each row free against ADR-10's budget. The response
       * roughly doubles in size; METRICS.SAMPLE_RATE_SECONDS states that arithmetic.
       *
       * CPU_USAGE, not CPU_USAGE_2. The higher-numbered member exists on the schema and
       * `pnpm probe:metrics` showed it returning an empty array — api.integration.test.ts
       * pins that so an "upgrade" to it cannot land silently.
       */
      measurements: ["CPU_USAGE", "MEMORY_USAGE_GB", "CPU_LIMIT", "MEMORY_LIMIT_GB"],
      startDate: new Date(Date.now() - METRICS.WINDOW_MS).toISOString(),
      sampleRateSeconds: METRICS.SAMPLE_RATE_SECONDS,
      averagingWindowSeconds: METRICS.AVERAGING_WINDOW_SECONDS,
    },
    { accessToken, signal },
  );

  // Every dashboard render, so a token that will never hold `workspace:viewer` would
  // otherwise warn per render forever — see logRefusals.
  logRefusals("railway.metrics.refused", { project_id: projectId }, errors);

  return {
    metrics: toContainerMetrics(data?.metrics ?? []),
    spend: toWorkspaceSpend(data?.project?.workspace ?? null),
  };
}
