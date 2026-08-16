/**
 * The create saga against a Railway that refuses at each step in turn.
 *
 * Four blocks and eight hundred lines, which is what a five-mutation saga with no transaction
 * costs to pin down: every step can fail after the ones before it took effect, and each
 * failure is a different outcome and a different sentence.
 */

import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { logRecords, rawLogLines } from "@/test/log-capture";
import { TOKEN, railwayApi, setupRailwayServer, volumeOk } from "@/test/railway-msw";
import { createContainer } from "./service-create";
import { railwayApiUrl } from "./client";

const api = railwayApi(railwayApiUrl());
const server = setupRailwayServer();
const volumeOkFor = volumeOk(api);

describe("createContainer", () => {
  it("creates then deploys, returning the deployment to stream", async () => {
    server.use(
      api.mutation("ServiceCreate", () =>
        HttpResponse.json({ data: { serviceCreate: { id: "svc_1", name: "spun-x" } } }),
      ),
      volumeOkFor(),
      api.mutation("ServiceInstanceDeployV2", () =>
        HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_1" } }),
      ),
    );

    const result = await createContainer(TOKEN, {
      projectId: "p1",
      environmentId: "e1",
      name: "spun-x",
      image: "redis:7-alpine",
    });

    expect(result).toEqual({
      serviceId: "svc_1",
      deploymentId: "dep_1",
      url: null,
      stored: null,
      outcome: "deployed",
    });
  });

  it("sets the environment before deploying, not after", async () => {
    /*
     * Order is the whole point. A postgres container started without POSTGRES_PASSWORD
     * exits on its first tick and Railway restarts it forever; setting the variables
     * afterwards would need a redeploy and would show that crash loop first.
     */
    const calls: string[] = [];
    server.use(
      api.mutation("ServiceCreate", () => {
        calls.push("create");
        return HttpResponse.json({
          data: { serviceCreate: { id: "svc_1", name: "spun-db" } },
        });
      }),
      volumeOkFor(() => calls.push("volume")),
      api.mutation("VariableCollectionUpsert", () => {
        calls.push("variables");
        return HttpResponse.json({ data: { variableCollectionUpsert: 1 } });
      }),
      api.mutation("ServiceInstanceDeployV2", () => {
        calls.push("deploy");
        return HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_1" } });
      }),
    );

    const result = await createContainer(TOKEN, {
      projectId: "p1",
      environmentId: "e1",
      name: "spun-db",
      image: "postgres:16-alpine",
      variables: { POSTGRES_PASSWORD: "generated" },
    });

    expect(calls).toEqual(["create", "volume", "variables", "deploy"]);
    expect(result.outcome).toBe("deployed");
  });

  it("asks Railway not to deploy on the variable change", async () => {
    /*
     * The deploy below returns the deployment id the row's log stream keys on. Railway
     * redeploys a service when its variables change, so without `skipDeploys` there is a
     * second deployment whose id this app never learns — and the row streams logs from a
     * deployment that is not the one it just started.
     *
     * `replace: false` is the other half: the mutation can wipe a service's existing
     * variables, and that is the wrong default to leave lying around in a call this app
     * makes on every spin-up.
     */
    let sent: Record<string, unknown> | undefined;
    server.use(
      api.mutation("ServiceCreate", () =>
        HttpResponse.json({
          data: { serviceCreate: { id: "svc_1", name: "spun-db" } },
        }),
      ),
      volumeOkFor(),
      api.mutation("VariableCollectionUpsert", ({ variables }) => {
        sent = variables.input as Record<string, unknown>;
        return HttpResponse.json({ data: { variableCollectionUpsert: 1 } });
      }),
      api.mutation("ServiceInstanceDeployV2", () =>
        HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_1" } }),
      ),
    );

    await createContainer(TOKEN, {
      projectId: "p1",
      environmentId: "e1",
      name: "spun-db",
      image: "postgres:16-alpine",
      variables: { POSTGRES_PASSWORD: "generated" },
    });

    expect(sent).toMatchObject({
      projectId: "p1",
      environmentId: "e1",
      serviceId: "svc_1",
      replace: false,
      skipDeploys: true,
    });
  });

  it("declines to deploy a service whose environment could not be set", async () => {
    /*
     * The service exists, is prefixed, and is destroyable from the dashboard. That is
     * strictly better than a running container in a restart loop nobody can diagnose —
     * the same reasoning as the un-deployed case above.
     */
    server.use(
      api.mutation("ServiceCreate", () =>
        HttpResponse.json({
          data: { serviceCreate: { id: "svc_1", name: "spun-db" } },
        }),
      ),
      volumeOkFor(),
      api.mutation("VariableCollectionUpsert", () =>
        HttpResponse.json({ errors: [{ message: "Not Authorized" }] }),
      ),
      api.mutation("ServiceInstanceDeployV2", () => {
        throw new Error("must not deploy an unconfigured service");
      }),
    );

    const result = await createContainer(TOKEN, {
      projectId: "p1",
      environmentId: "e1",
      name: "spun-db",
      image: "postgres:16-alpine",
      variables: { POSTGRES_PASSWORD: "generated" },
    });

    expect(result).toEqual({
      serviceId: "svc_1",
      deploymentId: null,
      url: null,
      stored: null,
      outcome: "variables_failed",
    });
  });

  it("reports the service when the deploy is refused, rather than throwing it away", async () => {
    /*
     * The regression T-471 names. A throw here carries no service id, so the caller could
     * not tell "nothing was created" from "a billable service exists and is not running",
     * and the audit line that says who created what never ran at all.
     */
    server.use(
      api.mutation("ServiceCreate", () =>
        HttpResponse.json({ data: { serviceCreate: { id: "svc_1", name: "spun-x" } } }),
      ),
      volumeOkFor(),
      api.mutation("ServiceInstanceDeployV2", () =>
        HttpResponse.json({ errors: [{ message: "Not Authorized" }] }),
      ),
    );

    const result = await createContainer(TOKEN, {
      projectId: "p1",
      environmentId: "e1",
      name: "spun-x",
      image: "redis:7-alpine",
    });

    expect(result).toEqual({
      serviceId: "svc_1",
      deploymentId: null,
      url: null,
      stored: null,
      outcome: "deploy_failed",
    });

    // The classification the user's sentence no longer carries has to survive somewhere,
    // and this record — incident id included — is where.
    const failure = logRecords().find((r) => r.msg === "railway.deploy_failed");
    expect(failure).toMatchObject({ service_id: "svc_1" });
    expect(failure?.err).toMatchObject({
      type: "RailwayApiError",
      operation: "ServiceInstanceDeployV2",
      incident: expect.stringMatching(/^[0-9a-f]{8}$/) as unknown as string,
    });
  });

  it("issues neither a variables nor a volume call for an image that boots bare", async () => {
    /*
     * nginx rather than redis, and the swap is the point rather than a detail. redis used to
     * be the bare image here; since T-491 it keeps state, so it takes a volume — and this
     * test would have been asserting the absence of a call the app now correctly makes.
     *
     * Both absences matter, and for the same reason: this app does not know where an
     * arbitrary image writes, so a volume attached anyway would be billable storage that
     * stays empty while the data still vanishes.
     */
    server.use(
      api.mutation("ServiceCreate", () =>
        HttpResponse.json({ data: { serviceCreate: { id: "svc_1", name: "spun-x" } } }),
      ),
      api.mutation("VariableCollectionUpsert", () => {
        throw new Error("no variables should be sent");
      }),
      api.mutation("VolumeCreate", () => {
        throw new Error("no volume should be attached to an image with no preset");
      }),
      api.mutation("ServiceInstanceDeployV2", () =>
        HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_1" } }),
      ),
    );

    await expect(
      createContainer(TOKEN, {
        projectId: "p1",
        environmentId: "e1",
        name: "spun-x",
        image: "nginx:alpine",
      }),
    ).resolves.toMatchObject({ outcome: "deployed" });
  });

  it("still reports the service when the deploy returns no id", async () => {
    // The service exists either way; the dashboard shows it as un-deployed rather
    // than silently orphaning it.
    server.use(
      api.mutation("ServiceCreate", () =>
        HttpResponse.json({ data: { serviceCreate: { id: "svc_1", name: "spun-x" } } }),
      ),
      volumeOkFor(),
      api.mutation("ServiceInstanceDeployV2", () =>
        HttpResponse.json({ data: { serviceInstanceDeployV2: null } }),
      ),
    );

    const result = await createContainer(TOKEN, {
      projectId: "p1",
      environmentId: "e1",
      name: "spun-x",
      image: "redis:7-alpine",
    });

    expect(result).toEqual({
      serviceId: "svc_1",
      deploymentId: null,
      url: null,
      stored: null,
      outcome: "deployed",
    });
  });
});
describe("createContainer, attaching a volume", () => {
  it("sends the catalog's mount path, scoped to one environment", async () => {
    /*
     * `environmentId` is the field to watch. Railway's own description says an ABSENT
     * environmentId deploys the volume to every environment in the project — so omitting
     * it for a service that lives in one would provision billable storage in all of them.
     */
    let sent: Record<string, unknown> | undefined;
    server.use(
      api.mutation("ServiceCreate", () =>
        HttpResponse.json({
          data: { serviceCreate: { id: "svc_1", name: "spun-db" } },
        }),
      ),
      volumeOkFor((input) => {
        sent = input;
      }),
      api.mutation("VariableCollectionUpsert", () =>
        HttpResponse.json({ data: { variableCollectionUpsert: 1 } }),
      ),
      api.mutation("ServiceInstanceDeployV2", () =>
        HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_1" } }),
      ),
    );

    await createContainer(TOKEN, {
      projectId: "p1",
      environmentId: "e1",
      name: "spun-db",
      image: "postgres:16-alpine",
      variables: { POSTGRES_PASSWORD: "generated" },
    });

    expect(sent).toEqual({
      projectId: "p1",
      environmentId: "e1",
      serviceId: "svc_1",
      mountPath: "/var/lib/postgresql/data",
    });
  });

  it("matches the mount path on the repository, so a different tag still gets one", async () => {
    let sent: Record<string, unknown> | undefined;
    server.use(
      api.mutation("ServiceCreate", () =>
        HttpResponse.json({
          data: { serviceCreate: { id: "svc_1", name: "spun-db" } },
        }),
      ),
      volumeOkFor((input) => {
        sent = input;
      }),
      api.mutation("ServiceInstanceDeployV2", () =>
        HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_1" } }),
      ),
    );

    await createContainer(TOKEN, {
      projectId: "p1",
      environmentId: "e1",
      name: "spun-cache",
      image: "redis:8",
    });

    expect(sent).toMatchObject({ mountPath: "/data" });
  });

  it("declines to deploy a stateful service whose volume was refused", async () => {
    /*
     * The branch T-491 exists for, and the one place where NOT deploying is the feature.
     * A database that came up here would look healthy, accept writes, and lose every one of
     * them the next time the container moved — which is exactly the defect being fixed. An
     * un-deployed service is visible, prefixed and destroyable instead.
     */
    server.use(
      api.mutation("ServiceCreate", () =>
        HttpResponse.json({
          data: { serviceCreate: { id: "svc_1", name: "spun-db" } },
        }),
      ),
      api.mutation("VolumeCreate", () =>
        HttpResponse.json({ errors: [{ message: "Not Authorized" }] }),
      ),
      api.mutation("VariableCollectionUpsert", () => {
        throw new Error("must not configure a service it will not deploy");
      }),
      api.mutation("ServiceInstanceDeployV2", () => {
        throw new Error("must not deploy a stateful service with no volume");
      }),
    );

    const result = await createContainer(TOKEN, {
      projectId: "p1",
      environmentId: "e1",
      name: "spun-db",
      image: "postgres:16-alpine",
      variables: { POSTGRES_PASSWORD: "generated" },
    });

    expect(result).toEqual({
      serviceId: "svc_1",
      deploymentId: null,
      url: null,
      stored: null,
      outcome: "volume_failed",
    });

    const failure = logRecords().find((r) => r.msg === "railway.volume_failed");
    expect(failure).toMatchObject({
      service_id: "svc_1",
      mount_path: "/var/lib/postgresql/data",
    });
  });

  it("records the name Railway derived, because that is what carries the prefix", async () => {
    /*
     * This app sends no name and never renames the volume. Railway derives one from the
     * service — `spun-db` gets `spun-db-volume` — which is how the MANAGED_PREFIX reaches
     * the volume for free, and is why `volumeUpdate` sits in OPTIONAL_FIELDS rather than
     * being a document. The record is what would show that behaviour changing.
     */
    server.use(
      api.mutation("ServiceCreate", () =>
        HttpResponse.json({
          data: { serviceCreate: { id: "svc_1", name: "spun-db" } },
        }),
      ),
      volumeOkFor(),
      api.mutation("ServiceInstanceDeployV2", () =>
        HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_1" } }),
      ),
    );

    await createContainer(TOKEN, {
      projectId: "p1",
      environmentId: "e1",
      name: "spun-db",
      image: "mongo:7",
    });

    expect(logRecords().find((r) => r.msg === "railway.volume_created")).toMatchObject({
      service_id: "svc_1",
      volume_id: "vol_1",
      volume_name: "spun-db-volume",
      mount_path: "/data/db",
    });
  });
});
describe("createContainer, applying the advanced resource controls", () => {
  /*
   * The four calls every case here needs, with the operation sequence recorded.
   *
   * The capture callbacks are on the stub rather than passed as a second `server.use`
   * handler for the same operation, because MSW answers with the first match — an override
   * registered after this one never runs, and the assertion silently reads `undefined`.
   * Same shape `volumeOk` above uses, for the same reason.
   */
  const stubs = (
    calls: string[],
    over: {
      settingsFail?: boolean;
      limitsFail?: boolean;
      onSettings?: (variables: Record<string, unknown>) => void;
      onLimits?: (input: Record<string, unknown>) => void;
      readBackFail?: boolean;
    } = {},
  ) => [
    api.mutation("ServiceCreate", () => {
      calls.push("create");
      return HttpResponse.json({
        data: { serviceCreate: { id: "svc_1", name: "spun-x" } },
      });
    }),
    api.mutation("ServiceInstanceUpdate", ({ variables }) => {
      calls.push("settings");
      over.onSettings?.(variables as Record<string, unknown>);
      return over.settingsFail
        ? HttpResponse.json({ errors: [{ message: "refused" }] }, { status: 200 })
        : HttpResponse.json({ data: { serviceInstanceUpdate: true } });
    }),
    api.mutation("ServiceInstanceLimitsUpdate", ({ variables }) => {
      calls.push("limits");
      over.onLimits?.((variables as { input: Record<string, unknown> }).input);
      return over.limitsFail
        ? HttpResponse.json({ errors: [{ message: "refused" }] }, { status: 200 })
        : HttpResponse.json({ data: { serviceInstanceLimitsUpdate: true } });
    }),
    api.mutation("ServiceInstanceDeployV2", () => {
      calls.push("deploy");
      return HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_1" } });
    }),
    /*
     * The read-back, which runs only when something was asked for — so it belongs here,
     * beside the two mutations under the same condition, rather than in the file's default
     * handlers where it would be answering on the no-settings path too.
     *
     * It echoes what it was sent, which is what makes the two cases below meaningful: one
     * overrides this to answer something else, and that is the shape of every finding this
     * request exists to catch.
     */
    api.query("ServiceInstance", () => {
      calls.push("read-back");
      if (over.readBackFail) {
        return HttpResponse.json({
          data: null,
          errors: [{ message: "Not Authorized" }],
        });
      }
      return HttpResponse.json({
        data: {
          serviceInstance: {
            id: "si_1",
            region: null,
            numReplicas: null,
            restartPolicyType: "ON_FAILURE",
            restartPolicyMaxRetries: 10,
            startCommand: null,
          },
        },
      });
    }),
  ];

  const create = (params: Record<string, unknown> = {}) =>
    createContainer(TOKEN, {
      projectId: "p1",
      environmentId: "e1",
      name: "spun-x",
      image: "nginx:1.27-alpine",
      ...params,
    });

  /*
   * The guarantee the whole design turns on: adding seven optional controls costs a spin-up
   * that used none of them exactly nothing. `onUnhandledRequest: "error"` is what makes the
   * absence an assertion rather than a claim — a request to either new mutation fails the
   * test with no handler to answer it.
   */
  it("issues no extra request when nothing was asked for", async () => {
    const calls: string[] = [];
    server.use(...stubs(calls));

    await create({ settings: {}, limits: {} });

    expect(calls).toEqual(["create", "deploy"]);
  });

  it("issues no extra request when the caller passes neither object", async () => {
    const calls: string[] = [];
    server.use(...stubs(calls));

    await create();

    expect(calls).toEqual(["create", "deploy"]);
  });

  /*
   * Settings before the volume, which is the ordering `region` fixes: a volume is
   * provisioned for the service as it stands, so a region applied afterwards is applied to a
   * service whose storage was already placed, and this app cannot move it.
   */
  it("applies the settings before the volume and before the deploy", async () => {
    const calls: string[] = [];
    server.use(
      ...stubs(calls),
      volumeOkFor(() => calls.push("volume")),
      api.mutation("VariableCollectionUpsert", () => {
        calls.push("variables");
        return HttpResponse.json({ data: { variableCollectionUpsert: 1 } });
      }),
    );

    await create({
      image: "postgres:16-alpine",
      variables: { POSTGRES_PASSWORD: "x" },
      settings: { region: "europe-west4-drams3a" },
      limits: { cpu: 0.5 },
    });

    // The read-back is last, after the deploy, and that is the only place it can be: it
    // asks what Railway ended up holding, so anything still to be written would make the
    // answer a guess about a service that is not finished being built.
    expect(calls).toEqual([
      "create",
      "settings",
      "limits",
      "volume",
      "variables",
      "deploy",
      "read-back",
    ]);
  });

  it("reads back what Railway stored, which is not always what it was told", async () => {
    /*
     * The whole reason this request exists. Every control on the Advanced panel is
     * write-only — none is rendered anywhere after the create — so a value Railway drops
     * could only be found by opening Railway's own dashboard and comparing by eye, and two
     * were: a region sent as an airport code was answered `true` and stored as `null`, and
     * a retry count of 3 came back as 10.
     *
     * The stub reproduces both. The point is not that the app corrects them — it cannot —
     * but that the record says so, so the next occurrence is a log query rather than a
     * manual comparison against somebody else's dashboard.
     */
    const calls: string[] = [];
    server.use(...stubs(calls));

    const result = await create({
      settings: {
        region: "europe-west4-drams3a",
        replicas: 2,
        restartRetries: 3,
      },
    });

    expect(result.stored).toEqual({
      region: null,
      replicas: null,
      restartPolicy: "ON_FAILURE",
      restartRetries: 10,
      startCommand: null,
    });
  });

  it("does not fail a created container over a refused read-back", async () => {
    /*
     * By the time this runs the service exists, is deployed, and is about to be on screen.
     * `ServiceInstance` is in DEGRADING_OPERATIONS for exactly this: losing a diagnostic
     * must cost the record its `stored_` fields and cost the user nothing.
     */
    const calls: string[] = [];
    server.use(...stubs(calls, { readBackFail: true }));

    const result = await create({ settings: { replicas: 2 } });

    expect(result).toMatchObject({ outcome: "deployed", stored: null });
  });

  it("asks nothing back when nothing was customised", async () => {
    // The round-trip guarantee this file opens with, restated for the new request: a
    // spin-up that used none of these controls has nothing to compare, and must not pay a
    // fourth round trip to learn that Railway has defaults.
    const calls: string[] = [];
    server.use(
      api.mutation("ServiceCreate", () => {
        calls.push("create");
        return HttpResponse.json({
          data: { serviceCreate: { id: "svc_1", name: "spun-x" } },
        });
      }),
      api.mutation("ServiceInstanceDeployV2", () => {
        calls.push("deploy");
        return HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_1" } });
      }),
    );

    // No ServiceInstance handler, and onUnhandledRequest is "error": a read-back here fails
    // the case rather than being asserted against.
    await create();

    expect(calls).toEqual(["create", "deploy"]);
  });

  it("sends only the members that were asked for", async () => {
    const calls: string[] = [];
    let sent: Record<string, unknown> | undefined;
    server.use(...stubs(calls, { onSettings: (variables) => (sent = variables) }));

    await create({ settings: { replicas: 3 } });

    expect(sent).toMatchObject({
      serviceId: "svc_1",
      // Always sent: an omitted environment updates the service in every non-fork
      // environment, which is a blast radius nobody asked for from a form naming one.
      environmentId: "e1",
      input: { numReplicas: 3 },
    });
    expect(Object.keys((sent?.input ?? {}) as object)).toEqual(["numReplicas"]);
  });

  it("maps every setting onto the member Railway names it", async () => {
    const calls: string[] = [];
    let input: Record<string, unknown> | undefined;
    server.use(
      ...stubs(calls, {
        onSettings: (variables) =>
          (input = (variables as { input: Record<string, unknown> }).input),
      }),
    );

    await create({
      settings: {
        region: "us-west2",
        replicas: 2,
        restartPolicy: "ON_FAILURE",
        restartRetries: 4,
        startCommand: "serve",
      },
    });

    expect(input).toEqual({
      region: "us-west2",
      numReplicas: 2,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 4,
      startCommand: "serve",
    });
  });

  it("sends CPU and memory to their own mutation, and only when asked", async () => {
    const calls: string[] = [];
    let input: Record<string, unknown> | undefined;
    server.use(...stubs(calls, { onLimits: (sent) => (input = sent) }));

    await create({ limits: { cpu: 0.5, memory: 2 } });

    expect(calls).toEqual(["create", "limits", "deploy"]);
    expect(input).toEqual({
      environmentId: "e1",
      serviceId: "svc_1",
      vCPUs: 0.5,
      memoryGB: 2,
    });
  });

  /*
   * A refusal does not deploy, on the argument the volume and variables branches make: a
   * container running in a region nobody asked for is a container quietly not doing what the
   * form said it would, and an un-deployed service is visible, prefixed and destroyable.
   */
  it("stops before the deploy when the settings are refused", async () => {
    const calls: string[] = [];
    server.use(...stubs(calls, { settingsFail: true }));

    const result = await create({ settings: { replicas: 3, startCommand: "serve" } });

    expect(result).toEqual({
      serviceId: "svc_1",
      deploymentId: null,
      url: null,
      stored: null,
      outcome: "settings_failed",
    });
    expect(calls).toEqual(["create", "settings"]);
  });

  it("stops before the deploy when the size is refused, which is usually the plan", async () => {
    const calls: string[] = [];
    server.use(...stubs(calls, { limitsFail: true }));

    const result = await create({ limits: { cpu: 32 } });

    expect(result.outcome).toBe("limits_failed");
    expect(calls).toEqual(["create", "limits"]);
  });

  /*
   * The start command is the one free-text field on the panel, so it is counted rather than
   * named — the split `container.created` already makes between preset variable names and a
   * count of the user's. Everything else here is closed or bounded and is named.
   */
  it("records the length of the start command and never the command", async () => {
    const calls: string[] = [];
    server.use(...stubs(calls, { settingsFail: true }));

    await create({
      settings: {
        region: "us-west2",
        replicas: 3,
        restartPolicy: "ALWAYS",
        startCommand: "serve --secret hunter2",
      },
    });

    const record = logRecords().find((line) => line.msg === "railway.settings_failed");
    expect(record).toMatchObject({
      service_id: "svc_1",
      region: "us-west2",
      replicas: 3,
      restart_policy: "ALWAYS",
      start_command_length: "serve --secret hunter2".length,
    });
    expect(rawLogLines().join("\n")).not.toContain("hunter2");
  });

  it("records the size that was refused", async () => {
    const calls: string[] = [];
    server.use(...stubs(calls, { limitsFail: true }));

    await create({ limits: { cpu: 32, memory: 64 } });

    expect(
      logRecords().find((line) => line.msg === "railway.limits_failed"),
    ).toMatchObject({ service_id: "svc_1", vcpus: 32, memory_gb: 64 });
  });
});
describe("createContainer, minting a public domain", () => {
  /** Railway answering `serviceDomainCreate`, with the input handed to the caller. */
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

  /** The two stubs every case here needs before the domain is even reached. */
  const createdAndDeployed = () => [
    api.mutation("ServiceCreate", () =>
      HttpResponse.json({ data: { serviceCreate: { id: "svc_1", name: "spun-web" } } }),
    ),
    api.mutation("ServiceInstanceDeployV2", () =>
      HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_1" } }),
    ),
  ];

  it("returns the url, with the scheme Railway serves it on", async () => {
    server.use(...createdAndDeployed(), domainOk());

    const result = await createContainer(TOKEN, {
      projectId: "p1",
      environmentId: "e1",
      name: "spun-web",
      image: "nginx:alpine",
      targetPort: 80,
    });

    expect(result).toEqual({
      serviceId: "svc_1",
      deploymentId: "dep_1",
      url: "https://spun-web-production.up.railway.app",
      stored: null,
      outcome: "deployed",
    });
  });

  it("sends the environment, the service and the port it was given", async () => {
    let input: Record<string, unknown> | undefined;
    server.use(
      ...createdAndDeployed(),
      domainOk((i) => (input = i)),
    );

    await createContainer(TOKEN, {
      projectId: "p1",
      environmentId: "e1",
      name: "spun-web",
      image: "ghcr.io/owner/api:1",
      targetPort: 8080,
    });

    expect(input).toEqual({
      environmentId: "e1",
      serviceId: "svc_1",
      targetPort: 8080,
    });
  });

  /*
   * The order is the argument in createContainer's docblock: a domain routes to a container
   * that is already coming up, so putting it before the deploy would only create a way for a
   * refused hostname to cost someone a running container.
   */
  it("mints the domain after the deploy, never before", async () => {
    const calls: string[] = [];
    server.use(
      api.mutation("ServiceCreate", () => {
        calls.push("create");
        return HttpResponse.json({
          data: { serviceCreate: { id: "svc_1", name: "spun-web" } },
        });
      }),
      api.mutation("ServiceInstanceDeployV2", () => {
        calls.push("deploy");
        return HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_1" } });
      }),
      domainOk(() => calls.push("domain")),
    );

    await createContainer(TOKEN, {
      projectId: "p1",
      environmentId: "e1",
      name: "spun-web",
      image: "nginx:alpine",
      targetPort: 80,
    });

    expect(calls).toEqual(["create", "deploy", "domain"]);
  });

  it("mints nothing when no port was asked for", async () => {
    server.use(
      ...createdAndDeployed(),
      volumeOkFor(),
      api.mutation("ServiceDomainCreate", () => {
        throw new Error("must not expose a container nobody asked to expose");
      }),
    );

    const result = await createContainer(TOKEN, {
      projectId: "p1",
      environmentId: "e1",
      name: "spun-cache",
      image: "redis:7-alpine",
    });

    expect(result.url).toBeNull();
    expect(result.outcome).toBe("deployed");
  });

  /*
   * The one Railway refusal in this whole function that does NOT change the outcome. Every
   * other branch leaves an un-deployed service the user has to clean up; this leaves the
   * container they asked for, running, missing one convenience — and the row's own control
   * is the retry.
   */
  it("still reports a deployed container when Railway refuses the domain", async () => {
    server.use(
      ...createdAndDeployed(),
      api.mutation("ServiceDomainCreate", () =>
        HttpResponse.json({ errors: [{ message: "Not Authorized" }] }),
      ),
    );

    const result = await createContainer(TOKEN, {
      projectId: "p1",
      environmentId: "e1",
      name: "spun-web",
      image: "nginx:alpine",
      targetPort: 80,
    });

    expect(result).toEqual({
      serviceId: "svc_1",
      deploymentId: "dep_1",
      url: null,
      stored: null,
      outcome: "deployed",
    });

    // The port is in the record because it is the likeliest cause: an image serving nothing
    // on the port the catalog claims, or a number someone typed for a custom image.
    expect(logRecords().find((r) => r.msg === "railway.domain_failed")).toMatchObject({
      service_id: "svc_1",
      target_port: 80,
    });
  });
});
