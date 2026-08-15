/**
 * Usage and workspace spend, which is the read most likely to come back half-refused.
 */

import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { logRecords } from "@/test/log-capture";
import { TOKEN, railwayApi, setupRailwayServer } from "@/test/railway-msw";
import { getProjectMetrics } from "./metrics";
import { railwayApiUrl } from "./client";

const api = railwayApi(railwayApiUrl());
const server = setupRailwayServer();

describe("getProjectMetrics", () => {
  /** Railway's real refusal shape, restated here so this block stands alone. */
  const notAuthorized = (path: string[]) => ({
    message: "Not Authorized",
    path,
    extensions: { code: "INTERNAL_SERVER_ERROR" },
  });

  /*
   * The shape a live probe returned: usage and ceilings for each service, plus the one
   * aggregate row Railway adds per measurement with no `serviceId` on it.
   */
  const metricsData = [
    {
      measurement: "CPU_USAGE",
      tags: { serviceId: "svc_1" },
      values: [{ ts: 1_760_000_000, value: 0.25 }],
    },
    {
      measurement: "MEMORY_USAGE_GB",
      tags: { serviceId: "svc_1" },
      values: [{ ts: 1_760_000_000, value: 0.5 }],
    },
    {
      measurement: "CPU_LIMIT",
      tags: { serviceId: "svc_1" },
      values: [{ ts: 1_760_000_000, value: 2 }],
    },
    {
      measurement: "MEMORY_LIMIT_GB",
      tags: { serviceId: "svc_1" },
      values: [{ ts: 1_760_000_000, value: 0.99999744 }],
    },
    {
      measurement: "CPU_USAGE",
      tags: { serviceId: "svc_2" },
      values: [{ ts: 1_760_000_000, value: 1.25 }],
    },
    {
      measurement: "CPU_USAGE",
      tags: { serviceId: null },
      values: [{ ts: 1_760_000_000, value: 0 }],
    },
  ];

  const projectData = {
    id: "p1",
    workspace: {
      id: "ws_1",
      name: "Acme",
      customer: {
        currentUsage: 18.4,
        billingPeriod: { start: "2026-08-01T00:00:00Z", end: "2026-08-31T00:00:00Z" },
      },
    },
  };

  it("reads usage per service and the workspace's spend in one request", async () => {
    server.use(
      api.query("ProjectMetrics", () =>
        HttpResponse.json({ data: { metrics: metricsData, project: projectData } }),
      ),
    );

    const { metrics, spend } = await getProjectMetrics(TOKEN, "p1", "e1");

    expect(metrics.svc_1).toEqual({
      serviceId: "svc_1",
      cpuCores: 0.25,
      memoryGb: 0.5,
      cpuLimitCores: 2,
      memoryLimitGb: 0.99999744,
      sampledAt: 1_760_000_000,
    });
    expect(metrics.svc_2?.cpuCores).toBe(1.25);
    // The aggregate row Railway sends with no serviceId does not become a service.
    expect(Object.keys(metrics)).toEqual(["svc_1", "svc_2"]);
    expect(spend).toEqual({
      currentUsage: 18.4,
      periodStart: "2026-08-01T00:00:00Z",
      periodEnd: "2026-08-31T00:00:00Z",
      workspaceName: "Acme",
    });
  });

  it("asks for the two usage measurements and the two ceilings, in one request", async () => {
    /*
     * `measurements` is a query variable, so the ceilings each row now shows cost no second
     * round trip — which is the only reason they fit inside ADR-10's request budget. The
     * assertion is on the variable rather than on the response, because that budget is about
     * what leaves this process.
     *
     * CPU_USAGE, never CPU_USAGE_2. The higher-numbered member exists on the schema and reads
     * like the newer of the two; a live probe showed it returning an empty array, so an
     * "upgrade" to it would silently blank the CPU column. This is where that is pinned.
     */
    let sent: Record<string, unknown> | undefined;
    server.use(
      api.query("ProjectMetrics", ({ variables }) => {
        sent = variables;
        return HttpResponse.json({
          data: { metrics: metricsData, project: projectData },
        });
      }),
    );

    await getProjectMetrics(TOKEN, "p1", "e1");

    expect(sent?.measurements).toEqual([
      "CPU_USAGE",
      "MEMORY_USAGE_GB",
      "CPU_LIMIT",
      "MEMORY_LIMIT_GB",
    ]);
    expect(sent?.measurements).not.toContain("CPU_USAGE_2");
  });

  it("keeps the usage when the workspace half is refused", async () => {
    /*
     * The case gqlPartial exists for, and the one a token without workspace:viewer hits on
     * every single render. `gql` would throw here and discard readings that arrived intact.
     */
    server.use(
      api.query("ProjectMetrics", () =>
        HttpResponse.json({
          data: { metrics: metricsData, project: { id: "p1", workspace: null } },
          errors: [notAuthorized(["project", "workspace"])],
        }),
      ),
    );

    const { metrics, spend } = await getProjectMetrics(TOKEN, "p1", "e1");

    expect(Object.keys(metrics)).toEqual(["svc_1", "svc_2"]);
    expect(spend).toBeNull();

    const record = logRecords().find((r) => r.msg === "railway.metrics.refused");
    expect(record).toBeDefined();
    // Debug, never warn: this fires on every render for a token that will never hold the
    // scope, and a warn per render is how a log store teaches people to ignore warns.
    expect(record?.level).toBe("debug");
    expect(
      logRecords().filter((r) => r.level === "warn" || r.level === "error"),
    ).toEqual([]);
  });

  it("keeps the spend when the metrics half is refused", async () => {
    // The mirror. Losing the readout must not lose the one real cost figure on the page.
    server.use(
      api.query("ProjectMetrics", () =>
        HttpResponse.json({
          data: { metrics: null, project: projectData },
          errors: [notAuthorized(["metrics"])],
        }),
      ),
    );

    const { metrics, spend } = await getProjectMetrics(TOKEN, "p1", "e1");

    expect(metrics).toEqual({});
    expect(spend?.currentUsage).toBe(18.4);
  });

  it("returns empty rather than throwing when both halves are refused", async () => {
    /*
     * The whole argument for Query.metrics being an OPTIONAL_FIELDS entry: a refusal
     * degrades the row, it does not blank the dashboard. A throw here would take the
     * container list down with it.
     */
    server.use(
      api.query("ProjectMetrics", () =>
        HttpResponse.json({
          data: { metrics: null, project: null },
          errors: [notAuthorized(["metrics"]), notAuthorized(["project"])],
        }),
      ),
    );

    await expect(getProjectMetrics(TOKEN, "p1", "e1")).resolves.toEqual({
      metrics: {},
      spend: null,
    });
  });

  it("still throws on a rate limit, because that is not a refusal", async () => {
    // The transport contract is unchanged. A 429 is the server saying "later", not "no",
    // and swallowing it would hide the one failure the retry logic is built around.
    server.use(
      api.query("ProjectMetrics", () =>
        HttpResponse.json({}, { status: 429, headers: { "retry-after": "0" } }),
      ),
    );

    await expect(getProjectMetrics(TOKEN, "p1", "e1")).rejects.toThrow();
  });
});
