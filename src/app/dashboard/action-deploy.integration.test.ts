import { HttpResponse, graphql } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { railwayApiUrl } from "@/lib/railway/client";
import { rawLogLines } from "@/test/log-capture";
import { projectWith, form, record } from "@/test/dashboard-fixtures";

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

const requireAccessToken = vi.fn(async () => "token");
/*
 * `spinUp` reads the whole session rather than the token alone: the idempotency key it
 * is handed is client-supplied, so the entry it claims has to be namespaced by who
 * claimed it. The two mocks must agree — a case that rejects one and not the other is
 * asserting against a session state production cannot be in.
 */
const requireSession = vi.fn(async () => ({
  user: { id: "u1" },
  accessToken: "token",
}));
vi.mock("@/lib/auth/server", () => ({
  requireAccessToken: () => requireAccessToken(),
  requireSession: () => requireSession(),
}));

const {
  stopContainer,
  restartContainer,
  redeployContainer,
  rollbackContainer,
  generateDomain,
} = await import("./actions");
const { __resetIdempotency } = await import("@/lib/idempotency");
const { applyStopped, __resetStopped } = await import("@/lib/railway/stopped");
const { getProjectContainers } = await import("@/lib/railway/projects");

const api = graphql.link(railwayApiUrl());
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

beforeEach(() => {
  revalidatePath.mockClear();
  requireAccessToken.mockReset();
  requireAccessToken.mockResolvedValue("token");
  requireSession.mockReset();
  requireSession.mockResolvedValue({ user: { id: "u1" }, accessToken: "token" });
  // Retained results are process-global and outlive the call that made them, so without
  // this a case would be served a previous case's container.
  __resetIdempotency();
  // Same reason, and the same shape of leak: the stopped map is process-global, so without
  // this a case would inherit a previous case's stop and read a running container as gone.
  __resetStopped();

  /*
   * `volumeCreate` answering, by default, because since T-491 it is an ordinary step of
   * creating the image every case in this file uses — redis keeps state, so it takes a
   * volume before it deploys. A default rather than a line in each case: without one, every
   * spin-up test would be silently exercising the `volume_failed` branch, and the cases
   * that mean to test that branch register their own refusal, which MSW ranks above this.
   */
  server.use(
    api.mutation("VolumeCreate", () =>
      HttpResponse.json({
        data: { volumeCreate: { id: "vol_1", name: "spun-cache-volume" } },
      }),
    ),
    /*
     * An environment with no volumes in it, which is what most environments are — and
     * `spinDown` reads this on every destroy now, not only when the box was ticked, because
     * the answer decides which sentence is true rather than which one was asked for. The
     * cases that care about a volume register their own.
     */
    api.query("EnvironmentVolumes", () =>
      HttpResponse.json({
        data: { environment: { id: "e1", volumeInstances: { edges: [] } } },
      }),
    ),
  );
});

/**
 * The verbs that act on a deployment — stop, restart, redeploy — and minting an address.
 *
 * Split from actions.integration.test.ts along the same seam the source module was, so a
 * verb's cases sit beside the module that implements it.
 */

describe("container lifecycle", () => {
  const actionForm = (serviceId: string, environmentId = "e1") =>
    form({ projectId: "p1", environmentId, serviceId });

  describe("stopContainer", () => {
    it("stops the deployment Railway reported, not one the client sent", async () => {
      const stopped: string[] = [];
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        api.mutation("DeploymentStop", ({ variables }) => {
          stopped.push(variables.id as string);
          return HttpResponse.json({ data: { deploymentStop: true } });
        }),
      );

      /*
       * A deployment id is posted alongside the service id and is expected to be ignored:
       * the action reads the id off the container it just re-derived ownership from, which
       * is the same rule that stops a forged serviceId working.
       */
      const data = actionForm("svc_managed");
      data.append("deploymentId", "dep_someone_elses");

      const result = await stopContainer(null, data);

      expect(result).toEqual({ ok: true, message: "Stopped cache" });
      expect(stopped).toEqual(["dep_svc_managed"]);
      expect(revalidatePath).toHaveBeenCalledWith("/dashboard");
    });

    it("refuses to stop a service it did not create", async () => {
      let stopCalls = 0;
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        api.mutation("DeploymentStop", () => {
          stopCalls += 1;
          return HttpResponse.json({ data: { deploymentStop: true } });
        }),
      );

      const result = await stopContainer(null, actionForm("svc_foreign"));

      expect(result).toEqual({
        ok: false,
        error: "This service was not created here, so this app cannot act on it.",
      });
      expect(stopCalls).toBe(0);
      expect(record("container.stop_refused")).toMatchObject({
        reason: "unmanaged",
        service_id: "svc_foreign",
      });
    });

    it("records what it stopped", async () => {
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        api.mutation("DeploymentStop", () =>
          HttpResponse.json({ data: { deploymentStop: true } }),
        ),
      );

      await stopContainer(null, actionForm("svc_managed"));

      // The audit trail this action shares with create and destroy: stopping changes what
      // is billed, so the record names the service and the deployment.
      expect(record("container.stopped")).toMatchObject({
        project_id: "p1",
        environment_id: "e1",
        service_id: "svc_managed",
        service_name: "spun-cache",
        deployment_id: "dep_svc_managed",
      });
    });

    it("remembers the stop, because Railway will not", async () => {
      /*
       * Measured live: `deploymentStop` answers `true`, the container really stops, and
       * `deployment.status` stays SUCCESS indefinitely. There is no terminal status for a
       * stopped deployment. So the app has to remember, or the row goes on reading Running
       * and `availableActions("running")` never offers the Redeploy that would bring it
       * back. `projectWith` still answers SUCCESS below — that is the point.
       */
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        api.mutation("DeploymentStop", () =>
          HttpResponse.json({ data: { deploymentStop: true } }),
        ),
      );

      await stopContainer(null, actionForm("svc_managed"));

      const { containers } = await getProjectContainers("token", "p1", "e1");
      const stopped = applyStopped(containers).find(
        (c) => c.serviceId === "svc_managed",
      );

      expect(containers.find((c) => c.serviceId === "svc_managed")?.state).toBe(
        "running",
      );
      expect(stopped?.state).toBe("removed");
    });

    it("remembers nothing when Railway refused the stop", async () => {
      // A refusal that left a memory behind would show a container as stopped that is
      // still running, and take away the Stop control that would actually stop it.
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        api.mutation("DeploymentStop", () =>
          HttpResponse.json({ errors: [{ message: "Deployment not found" }] }),
        ),
      );

      const result = await stopContainer(null, actionForm("svc_managed"));
      const { containers } = await getProjectContainers("token", "p1", "e1");

      expect(result.ok).toBe(false);
      expect(applyStopped(containers)[0]?.state).toBe("running");
    });

    it("forgets it as soon as another verb runs", async () => {
      /*
       * A restart keeps the same deployment id and Railway walks the status back to
       * SUCCESS, so a restarted container is indistinguishable from a stopped one in the
       * response. `withManagedContainer` clearing on every verb but stop is the only thing
       * that tells them apart — and without it the row would be stuck offering Redeploy,
       * which on a running container mints a second deployment of it.
       */
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        api.mutation("DeploymentStop", () =>
          HttpResponse.json({ data: { deploymentStop: true } }),
        ),
        api.mutation("DeploymentRestart", () =>
          HttpResponse.json({ data: { deploymentRestart: true } }),
        ),
      );

      await stopContainer(null, actionForm("svc_managed"));
      await restartContainer(null, actionForm("svc_managed"));

      const { containers } = await getProjectContainers("token", "p1", "e1");
      expect(applyStopped(containers)[0]?.state).toBe("running");
    });

    it("says so when the service has no deployment to stop", async () => {
      // No DeploymentStop handler: onUnhandledRequest is "error", so an attempted
      // mutation fails the case rather than being asserted for.
      server.use(
        api.query("Project", () =>
          HttpResponse.json({
            data: projectWith([
              { id: "svc_managed", name: "spun-cache", undeployed: true },
            ]),
          }),
        ),
      );

      const result = await stopContainer(null, actionForm("svc_managed"));

      expect(result).toEqual({
        ok: false,
        error:
          "That container has no deployment to act on. Reload the page and try again.",
      });
    });

    it("reports a service that has already gone and refreshes the list", async () => {
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
      );

      const result = await stopContainer(null, actionForm("svc_missing"));

      expect(result).toEqual({ ok: false, error: "That container no longer exists." });
      expect(record("container.stop_skipped")).toMatchObject({ reason: "gone" });
      expect(revalidatePath).toHaveBeenCalledWith("/dashboard");
    });

    it("propagates a refused stop as a readable message", async () => {
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        api.mutation("DeploymentStop", () =>
          HttpResponse.json({ errors: [{ message: "Deployment is locked" }] }),
        ),
      );

      const result = await stopContainer(null, actionForm("svc_managed"));

      expect(result).toMatchObject({
        ok: false,
        error: expect.stringMatching(
          /^Railway refused this operation .* Reference [0-9a-f]{8}\.$/,
        ),
      });
      expect(JSON.stringify(result)).not.toContain("Deployment is locked");
    });
  });

  describe("restartContainer", () => {
    it("restarts the deployment in place", async () => {
      const restarted: string[] = [];
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        api.mutation("DeploymentRestart", ({ variables }) => {
          restarted.push(variables.id as string);
          return HttpResponse.json({ data: { deploymentRestart: true } });
        }),
      );

      const result = await restartContainer(null, actionForm("svc_managed"));

      expect(result).toEqual({ ok: true, message: "Restarting cache" });
      /*
       * The same deployment id, which is the whole difference between this and redeploy:
       * a log pane already subscribed to it keeps streaming rather than being left on a
       * deployment nobody is looking at.
       */
      expect(restarted).toEqual(["dep_svc_managed"]);
      expect(record("container.restarted")).toMatchObject({
        service_id: "svc_managed",
        deployment_id: "dep_svc_managed",
      });
    });

    it("refuses to restart a service it did not create", async () => {
      let restartCalls = 0;
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        api.mutation("DeploymentRestart", () => {
          restartCalls += 1;
          return HttpResponse.json({ data: { deploymentRestart: true } });
        }),
      );

      const result = await restartContainer(null, actionForm("svc_foreign"));

      expect(result).toMatchObject({ ok: false });
      expect(restartCalls).toBe(0);
    });
  });

  describe("redeployContainer", () => {
    it("deploys the service instance and records the new deployment", async () => {
      const deployed: Array<Record<string, unknown>> = [];
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        api.mutation("ServiceInstanceDeployV2", ({ variables }) => {
          deployed.push(variables);
          return HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_fresh" } });
        }),
      );

      const result = await redeployContainer(null, actionForm("svc_managed"));

      expect(result).toEqual({ ok: true, message: "Redeploying cache" });
      expect(deployed[0]).toMatchObject({
        serviceId: "svc_managed",
        environmentId: "e1",
      });
      // The new id, not the old one — this is the record that says which deployment the
      // row is about to stream.
      expect(record("container.redeployed")).toMatchObject({
        service_id: "svc_managed",
        deployment_id: "dep_fresh",
      });
    });

    it("redeploys a service whose first deploy Railway refused", async () => {
      /*
       * The case that decided which mutation backs this action. `deploymentRedeploy` takes
       * a deployment id and this service has none, so the only call that can rescue the
       * orphan is `serviceInstanceDeployV2` — which is what spin-up's own
       * "Redeploy it from its row" sentence promises.
       */
      server.use(
        api.query("Project", () =>
          HttpResponse.json({
            data: projectWith([
              { id: "svc_managed", name: "spun-cache", undeployed: true },
            ]),
          }),
        ),
        api.mutation("ServiceInstanceDeployV2", () =>
          HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_first" } }),
        ),
      );

      const result = await redeployContainer(null, actionForm("svc_managed"));

      expect(result).toEqual({ ok: true, message: "Redeploying cache" });
    });

    it("refuses to redeploy a service it did not create", async () => {
      let deployCalls = 0;
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        api.mutation("ServiceInstanceDeployV2", () => {
          deployCalls += 1;
          return HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_x" } });
        }),
      );

      const result = await redeployContainer(null, actionForm("svc_foreign"));

      expect(result).toMatchObject({ ok: false });
      expect(deployCalls).toBe(0);
    });

    it("refuses an owned service posted against another environment", async () => {
      /*
       * Ownership is derived per environment, and this action sends an environment id to
       * Railway — so a service that has no instance in the environment submitted is
       * unknown here, and the action refuses rather than deploying it somewhere the user
       * was not looking.
       */
      let deployCalls = 0;
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        api.mutation("ServiceInstanceDeployV2", () => {
          deployCalls += 1;
          return HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_x" } });
        }),
      );

      const result = await redeployContainer(null, actionForm("svc_managed", "e2"));

      expect(result).toEqual({ ok: false, error: "That container no longer exists." });
      expect(deployCalls).toBe(0);
    });
  });

  describe("rollbackContainer", () => {
    /**
     * The service's own deployment history: the one running now, and an older one to
     * return to.
     *
     * `dep_svc_managed` is what `projectWith` reports as the current deployment, so the two
     * halves of every case below agree about which row is which.
     */
    const history = (
      entries: Array<{ id: string; canRollback?: boolean; status?: string }> = [
        { id: "dep_svc_managed" },
        { id: "dep_older" },
      ],
    ) =>
      api.query("Deployments", () =>
        HttpResponse.json({
          data: {
            deployments: {
              edges: entries.map((entry, index) => ({
                node: {
                  id: entry.id,
                  status: entry.status ?? "SUCCESS",
                  createdAt: `2026-08-0${index + 1}T00:00:00.000Z`,
                  canRollback: entry.canRollback ?? true,
                },
              })),
            },
          },
        }),
      );

    const rollbackForm = (deploymentId: string, serviceId = "svc_managed") => {
      const data = actionForm(serviceId);
      data.append("deploymentId", deploymentId);
      return data;
    };

    it("rolls back to a deployment of this service and records both ids", async () => {
      const rolled: string[] = [];
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        history(),
        api.mutation("DeploymentRollback", ({ variables }) => {
          rolled.push(variables.id as string);
          return HttpResponse.json({ data: { deploymentRollback: true } });
        }),
      );

      const result = await rollbackContainer(null, rollbackForm("dep_older"));

      expect(result).toEqual({ ok: true, message: "Rolling cache back" });
      expect(rolled).toEqual(["dep_older"]);
      expect(revalidatePath).toHaveBeenCalledWith("/dashboard");
      /*
       * `from_deployment_id` beside `deployment_id`, which no other verb's record carries:
       * a rollback is the one after which what was running before appears nowhere else in
       * the trail.
       */
      expect(record("container.rolled_back")).toMatchObject({
        service_id: "svc_managed",
        service_name: "spun-cache",
        deployment_id: "dep_older",
        from_deployment_id: "dep_svc_managed",
      });
    });

    it("refuses a deployment id that belongs to another service", async () => {
      /*
       * The case the whole design turns on. Every other verb reads its deployment id off
       * the container the guard just re-derived; this one accepts it from the browser, so
       * the list read — scoped by the serviceId on the resolved target rather than by the
       * one posted — is what stands in for that. No DeploymentRollback handler is
       * registered: `onUnhandledRequest: "error"` is what proves the mutation never left.
       */
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        history(),
      );

      const result = await rollbackContainer(
        null,
        rollbackForm("dep_someone_elses_service"),
      );

      expect(result).toMatchObject({ ok: false });
      expect(record("container.rollback_refused")).toMatchObject({
        reason: "not_in_service",
        service_id: "svc_managed",
      });
    });

    it("does not log the deployment id it refused", async () => {
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        history(),
      );

      await rollbackContainer(null, rollbackForm("dep_forged_and_unbounded"));

      /*
       * Caller-chosen and unbounded, which is the call the stream route already makes about
       * a deploymentId it rejects. `reason` carries the diagnostic content instead.
       */
      expect(rawLogLines().join("\n")).not.toContain("dep_forged_and_unbounded");
    });

    it("refuses a deployment Railway will not roll back to", async () => {
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        history([
          { id: "dep_svc_managed" },
          { id: "dep_older", canRollback: false, status: "FAILED" },
        ]),
      );

      const result = await rollbackContainer(null, rollbackForm("dep_older"));

      expect(result).toMatchObject({ ok: false });
      expect(record("container.rollback_refused")).toMatchObject({
        reason: "not_rollbackable",
      });
    });

    it("refuses to roll back to the deployment already running", async () => {
      // Refused before the list is even read, so no Deployments handler is registered.
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
      );

      const result = await rollbackContainer(null, rollbackForm("dep_svc_managed"));

      expect(result).toEqual({
        ok: false,
        error: "cache is already running that deployment.",
      });
      expect(record("container.rollback_skipped")).toMatchObject({ reason: "current" });
      expect(revalidatePath).toHaveBeenCalledWith("/dashboard");
    });

    it("fails closed when Railway refuses the deployment list", async () => {
      /*
       * `Deployments` is a degrading read, so a refusal returns an empty list rather than
       * throwing — and an empty list contains nothing, so the posted id matches nothing and
       * the mutation is never sent. The direction this fails in is the point.
       */
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        api.query("Deployments", () =>
          HttpResponse.json({
            data: null,
            errors: [{ message: "Not Authorized", path: ["deployments"] }],
          }),
        ),
      );

      const result = await rollbackContainer(null, rollbackForm("dep_older"));

      expect(result).toMatchObject({ ok: false });
      expect(record("container.rollback_refused")).toMatchObject({
        reason: "not_in_service",
      });
    });

    it("refuses to roll back a service it did not create", async () => {
      // Neither handler registered: the ownership guard runs before the list is read, so a
      // request that reached either one would fail this case rather than be asserted for.
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
      );

      const result = await rollbackContainer(
        null,
        rollbackForm("dep_older", "svc_foreign"),
      );

      expect(result).toEqual({
        ok: false,
        error: "This service was not created here, so this app cannot act on it.",
      });
      expect(record("container.rollback_refused")).toMatchObject({
        reason: "unmanaged",
      });
    });

    it("refuses a request carrying no deployment id at all", async () => {
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
      );

      const result = await rollbackContainer(null, actionForm("svc_managed"));

      expect(result).toEqual({ ok: false, error: "Missing container reference." });
    });
  });

  describe("generateDomain", () => {
    /** Railway minting a hostname, with the input handed back to the caller. */
    const domainOk = (onCall?: (input: Record<string, unknown>) => void) =>
      api.mutation("ServiceDomainCreate", ({ variables }) => {
        onCall?.(variables.input as Record<string, unknown>);
        return HttpResponse.json({
          data: {
            serviceDomainCreate: {
              id: "dom_1",
              domain: "spun-web-production.up.railway.app",
              targetPort: 80,
            },
          },
        });
      });

    it("mints a domain and names it in the sentence", async () => {
      server.use(
        api.query("Project", () =>
          HttpResponse.json({
            data: projectWith([
              { id: "svc_managed", name: "spun-web", image: "nginx:alpine" },
            ]),
          }),
        ),
        domainOk(),
      );

      const result = await generateDomain(null, actionForm("svc_managed"));

      expect(result).toEqual({
        ok: true,
        message: "web is now at https://spun-web-production.up.railway.app",
      });
      expect(revalidatePath).toHaveBeenCalledWith("/dashboard");
    });

    /*
     * The rule this action is built on. The browser posts three ids and nothing else, so the
     * port cannot be chosen by the request — it comes from the catalog, keyed on the image
     * Railway itself reported for the service.
     */
    it("takes the port from the catalog rather than from the request", async () => {
      let input: Record<string, unknown> | undefined;
      server.use(
        api.query("Project", () =>
          HttpResponse.json({
            data: projectWith([
              { id: "svc_managed", name: "spun-web", image: "nginx:alpine" },
            ]),
          }),
        ),
        domainOk((i) => (input = i)),
      );

      const data = actionForm("svc_managed");
      data.append("port", "9999");

      await generateDomain(null, data);

      expect(input).toEqual({
        environmentId: "e1",
        serviceId: "svc_managed",
        targetPort: 80,
      });
      expect(record("container.domain_created")).toMatchObject({
        service_id: "svc_managed",
        target_port: 80,
      });
    });

    it("lets Railway infer the port for an image the catalog does not know", async () => {
      let input: Record<string, unknown> | undefined;
      server.use(
        api.query("Project", () =>
          HttpResponse.json({
            data: projectWith([
              { id: "svc_managed", name: "spun-api", image: "ghcr.io/owner/api:1" },
            ]),
          }),
        ),
        domainOk((i) => (input = i)),
      );

      await generateDomain(null, actionForm("svc_managed"));

      expect("targetPort" in (input ?? {})).toBe(false);
      // Zero, so the record distinguishes "the app chose 80" from "Railway chose" — which
      // is the question asked when a domain points somewhere unexpected.
      expect(record("container.domain_created")).toMatchObject({ target_port: 0 });
    });

    /*
     * `serviceDomainCreate` mints a SECOND domain rather than refusing one, so a stale page
     * or two tabs would leave a service with two hostnames and a row showing whichever
     * sorted first. The guard is on Railway's own answer, like the ownership check above it.
     */
    it("refuses a container that already has an address, without calling Railway", async () => {
      let mintCalls = 0;
      server.use(
        api.query("Project", () =>
          HttpResponse.json({
            data: projectWith([
              {
                id: "svc_managed",
                name: "spun-web",
                image: "nginx:alpine",
                domain: "spun-web-production.up.railway.app",
              },
            ]),
          }),
        ),
        api.mutation("ServiceDomainCreate", () => {
          mintCalls += 1;
          return HttpResponse.json({
            data: {
              serviceDomainCreate: { id: "dom_2", domain: "second", targetPort: 80 },
            },
          });
        }),
      );

      const result = await generateDomain(null, actionForm("svc_managed"));

      expect(result).toEqual({
        ok: false,
        error: "web already has a public URL. Reload the page to see it.",
      });
      expect(mintCalls).toBe(0);
      expect(record("container.domain_skipped")).toMatchObject({ reason: "exists" });
    });

    it("refuses to expose a service it did not create", async () => {
      let mintCalls = 0;
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        api.mutation("ServiceDomainCreate", () => {
          mintCalls += 1;
          return HttpResponse.json({
            data: {
              serviceDomainCreate: { id: "dom_1", domain: "nope", targetPort: 80 },
            },
          });
        }),
      );

      const result = await generateDomain(null, actionForm("svc_foreign"));

      expect(result).toEqual({
        ok: false,
        error: "This service was not created here, so this app cannot act on it.",
      });
      expect(mintCalls).toBe(0);
      expect(record("container.domain_refused")).toMatchObject({
        reason: "unmanaged",
        service_id: "svc_foreign",
      });
    });

    it("reports a Railway refusal as a failure rather than a silent no-op", async () => {
      server.use(
        api.query("Project", () =>
          HttpResponse.json({
            data: projectWith([
              { id: "svc_managed", name: "spun-web", image: "nginx:alpine" },
            ]),
          }),
        ),
        api.mutation("ServiceDomainCreate", () =>
          HttpResponse.json({ errors: [{ message: "Not Authorized" }] }),
        ),
      );

      const result = await generateDomain(null, actionForm("svc_managed"));

      expect(result.ok).toBe(false);
    });
  });
});
