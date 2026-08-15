/**
 * The verbs that act on a deployment, and the history a rollback is checked against.
 */

import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { LIST } from "@/lib/constants";
import { logRecords } from "@/test/log-capture";
import { TOKEN, railwayApi, setupRailwayServer } from "@/test/railway-msw";
import {
  destroyContainer,
  listServiceDeployments,
  rollbackDeployment,
} from "./service-lifecycle";
import { railwayApiUrl } from "./client";

const api = railwayApi(railwayApiUrl());
const server = setupRailwayServer();

describe("destroyContainer", () => {
  it("sends the service id", async () => {
    let seen: string | undefined;
    server.use(
      api.mutation("ServiceDelete", ({ variables }) => {
        seen = variables.id as string;
        return HttpResponse.json({ data: { serviceDelete: true } });
      }),
    );

    await destroyContainer(TOKEN, "svc_1");
    expect(seen).toBe("svc_1");
  });
});
describe("listServiceDeployments", () => {
  /** One node of the connection, with only the members the document selects. */
  const dep = (
    id: string,
    createdAt: string,
    { status = "SUCCESS", canRollback = true } = {},
  ) => ({ node: { id, status, createdAt, canRollback } });

  const params = { projectId: "p1", environmentId: "e1", serviceId: "svc_1" };

  it("scopes the read to one service and asks for the newest entries", async () => {
    let variables: Record<string, unknown> = {};
    server.use(
      api.query("Deployments", (req) => {
        variables = req.variables;
        return HttpResponse.json({ data: { deployments: { edges: [] } } });
      }),
    );

    await listServiceDeployments(TOKEN, params);

    /*
     * All three ids, not just the service. `DeploymentListInput` accepts each of them and
     * Railway's own deprecation notice on `service.deployments` is about scoped access
     * control — sending the narrowest input the field offers is what that notice asks for.
     */
    expect(variables.input).toEqual({
      projectId: "p1",
      environmentId: "e1",
      serviceId: "svc_1",
    });
    expect(variables.last).toBe(LIST.DEPLOYMENT_HISTORY);
  });

  it("reports an empty history as answered, not refused", async () => {
    // The distinction the caller renders two different sentences from: a service that has
    // never deployed is not a service whose deployments could not be read.
    server.use(
      api.query("Deployments", () =>
        HttpResponse.json({ data: { deployments: { edges: [] } } }),
      ),
    );

    await expect(listServiceDeployments(TOKEN, params)).resolves.toEqual({
      entries: [],
      refused: false,
    });
  });

  it("returns the newest deployment first, whatever order Railway sent", async () => {
    server.use(
      api.query("Deployments", () =>
        HttpResponse.json({
          data: {
            deployments: {
              edges: [
                dep("dep_old", "2026-08-15T09:00:00.000Z"),
                dep("dep_new", "2026-08-15T11:00:00.000Z"),
                dep("dep_mid", "2026-08-15T10:00:00.000Z"),
              ],
            },
          },
        }),
      ),
    );

    /*
     * The document asks for `last`, on the strength of the one observation this app has of
     * Railway's Relay ordering — and sorts anyway. An upstream ordering that changed would
     * otherwise silently offer the wrong entries with nothing failing.
     */
    const { entries } = await listServiceDeployments(TOKEN, params);
    expect(entries.map((d) => d.id)).toEqual(["dep_new", "dep_mid", "dep_old"]);
  });

  it("maps the status to a container state and keeps Railway's own enum member", async () => {
    server.use(
      api.query("Deployments", () =>
        HttpResponse.json({
          data: {
            deployments: {
              edges: [
                dep("dep_1", "2026-08-15T09:00:00.000Z", {
                  status: "CRASHED",
                  canRollback: false,
                }),
              ],
            },
          },
        }),
      ),
    );

    expect(await listServiceDeployments(TOKEN, params)).toEqual({
      entries: [
        {
          id: "dep_1",
          state: "failed",
          rawStatus: "CRASHED",
          createdAt: "2026-08-15T09:00:00.000Z",
          canRollback: false,
        },
      ],
      refused: false,
    });
  });

  it("degrades to an empty list, and says the refusal is why", async () => {
    server.use(
      api.query("Deployments", () =>
        HttpResponse.json({
          data: null,
          errors: [{ message: "Not Authorized", path: ["deployments"] }],
        }),
      ),
    );

    /*
     * Does not throw, which is the whole reason this read is `gqlPartial` and has a
     * DEGRADING_OPERATIONS entry. It is also what makes `rollback` fail closed: no entries
     * means the posted deployment id matches nothing, so the mutation is never sent.
     */
    await expect(listServiceDeployments(TOKEN, params)).resolves.toEqual({
      entries: [],
      refused: true,
    });

    const refused = logRecords().filter(
      (record) => record.msg === "railway.deployments.refused",
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ service_id: "svc_1" });
  });
});
describe("rollbackDeployment", () => {
  it("sends the deployment id", async () => {
    let seen: string | undefined;
    server.use(
      api.mutation("DeploymentRollback", ({ variables }) => {
        seen = variables.id as string;
        return HttpResponse.json({ data: { deploymentRollback: true } });
      }),
    );

    await rollbackDeployment(TOKEN, "dep_old");
    expect(seen).toBe("dep_old");
  });
});
