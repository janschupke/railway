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

const { stopContainer, restartContainer, redeployContainer, generateDomain } =
  await import("./actions");
const { __resetIdempotency } = await import("@/lib/idempotency");

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
