/**
 * The reads that run for the life of an open log stream.
 *
 * These lived in `api.integration.test.ts` while their subject lived in
 * `deployment-reads.ts`, so the module with the longest-running reads in the app had no test
 * file bearing its name. Nothing moved but the file they are written in.
 */

import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { STREAM } from "@/lib/constants";
import { logRecords, rawLogLines } from "@/test/log-capture";
import { TOKEN, railwayApi, setupRailwayServer } from "@/test/railway-msw";
import { getDeployment, getDeploymentFailure, getLogs } from "./deployment-reads";
import { railwayApiUrl } from "./client";

const api = railwayApi(railwayApiUrl());
const server = setupRailwayServer();

describe("getDeployment", () => {
  it("returns the deployment", async () => {
    server.use(
      api.query("Deployment", () =>
        HttpResponse.json({
          data: { deployment: { id: "dep_1", status: "BUILDING", updatedAt: null } },
        }),
      ),
    );

    expect(await getDeployment(TOKEN, "dep_1")).toMatchObject({ status: "BUILDING" });
  });

  it("returns null for a deployment that no longer exists", async () => {
    server.use(
      api.query("Deployment", () => HttpResponse.json({ data: { deployment: null } })),
    );
    expect(await getDeployment(TOKEN, "gone")).toBeNull();
  });
});
describe("getDeploymentFailure", () => {
  /** One node of the event feed, with only the members the picker reads. */
  const evt = (step: string, payload: Record<string, unknown> | null = null) => ({
    node: { step, payload },
  });

  it("reads the tail of the feed and reports the newest reason", async () => {
    let variables: Record<string, unknown> = {};
    server.use(
      api.query("DeploymentEvents", (req) => {
        variables = req.variables;
        return HttpResponse.json({
          data: {
            deploymentEvents: {
              edges: [
                evt("SNAPSHOT_CODE", { error: null }),
                evt("BUILD_IMAGE", { error: "manifest for redis:nope not found" }),
              ],
            },
          },
        });
      }),
    );

    expect(await getDeploymentFailure(TOKEN, "dep_1")).toEqual({
      step: "BUILD_IMAGE",
      reason: "manifest for redis:nope not found",
    });
    expect(variables).toEqual({ id: "dep_1", last: STREAM.FAILURE_EVENTS });
  });

  it("returns null for a feed with nothing in it", async () => {
    server.use(
      api.query("DeploymentEvents", () =>
        HttpResponse.json({ data: { deploymentEvents: { edges: [] } } }),
      ),
    );

    expect(await getDeploymentFailure(TOKEN, "dep_1")).toBeNull();
  });

  it("keeps the step Railway did answer when it refuses the payload", async () => {
    /*
     * The reason this uses gqlPartial. Railway refuses a field it does not permit with
     * HTTP 200, an errors[] entry and the field nulled — `gql` throws on that and would
     * discard the step that arrived intact beside it.
     */
    server.use(
      api.query("DeploymentEvents", () =>
        HttpResponse.json({
          data: { deploymentEvents: { edges: [evt("HEALTHCHECK", null)] } },
          errors: [
            {
              message: "Not Authorized",
              path: ["deploymentEvents", "edges", "0", "node", "payload"],
              extensions: { code: "INTERNAL_SERVER_ERROR" },
            },
          ],
        }),
      ),
    );

    expect(await getDeploymentFailure(TOKEN, "dep_1")).toEqual({
      step: "HEALTHCHECK",
      reason: null,
    });
    expect(logRecords().map((r) => r.msg)).toContain(
      "railway.deployment.failure_reason_refused",
    );
  });

  it("bounds an unbounded reason before it can leave the server", async () => {
    server.use(
      api.query("DeploymentEvents", () =>
        HttpResponse.json({
          data: {
            deploymentEvents: {
              edges: [evt("BUILD_IMAGE", { error: "overflow ".repeat(2000) })],
            },
          },
        }),
      ),
    );

    const failure = await getDeploymentFailure(TOKEN, "dep_1");

    expect(failure?.reason?.length).toBeLessThanOrEqual(STREAM.FAILURE_REASON_MAX + 1);
  });

  it("never writes the reason text to the log, only its length", async () => {
    // Unbounded and partly container-authored, so it is the label the logging rules keep
    // out of a log store. The user reads it on their own screen instead.
    const secretish = "postgres://someone:hunter2@db.internal:5432";
    server.use(
      api.query("DeploymentEvents", () =>
        HttpResponse.json({
          data: {
            deploymentEvents: {
              edges: [evt("PRE_DEPLOY_COMMAND", { error: secretish })],
            },
          },
        }),
      ),
    );

    await getDeploymentFailure(TOKEN, "dep_1");

    expect(rawLogLines().join("\n")).not.toContain("hunter2");
    const record = logRecords().find(
      (r) => r.msg === "railway.deployment.failure_reason",
    );
    expect(record).toMatchObject({
      step: "PRE_DEPLOY_COMMAND",
      reason_length: secretish.length,
    });
  });

  it("throws a transport failure rather than swallowing it here", async () => {
    /*
     * Deliberate: every other read in this file throws, and the monitor's catch is the one
     * place "best effort" is spelled out. A second swallow here would mean two.
     */
    server.use(
      api.query("DeploymentEvents", () => HttpResponse.json({}, { status: 500 })),
    );

    await expect(getDeploymentFailure(TOKEN, "dep_1")).rejects.toThrow();
  });
});
describe("getLogs", () => {
  it("reads deploy logs by default and applies the backfill limit", async () => {
    let variables: Record<string, unknown> = {};
    server.use(
      api.query("DeploymentLogs", (req) => {
        variables = req.variables;
        return HttpResponse.json({
          data: { deploymentLogs: [{ timestamp: "t", message: "hello" }] },
        });
      }),
    );

    const lines = await getLogs(TOKEN, "dep_1", "deploy");

    expect(lines).toEqual([{ timestamp: "t", message: "hello" }]);
    expect(variables.limit).toBe(STREAM.BACKFILL_LINES);
  });

  it("reads build logs from the other field", async () => {
    server.use(
      api.query("BuildLogs", () =>
        HttpResponse.json({
          data: { buildLogs: [{ timestamp: "t", message: "step 1" }] },
        }),
      ),
    );

    expect(await getLogs(TOKEN, "dep_1", "build")).toHaveLength(1);
  });

  it("treats a null log field as empty", async () => {
    server.use(
      api.query("DeploymentLogs", () =>
        HttpResponse.json({ data: { deploymentLogs: null } }),
      ),
    );

    expect(await getLogs(TOKEN, "dep_1", "deploy")).toEqual([]);
  });
});
