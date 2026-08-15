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
import { LIMITS } from "@/lib/constants";
import { logRecords } from "@/test/log-capture";
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

const { spinDown, spinDownMany } = await import("./actions");
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
 * Destroying one container and destroying several, and what happens to the volume.
 *
 * Split from actions.integration.test.ts along the same seam the source module was, so a
 * verb's cases sit beside the module that implements it.
 */

describe("spinDown", () => {
  const downForm = (serviceId: string) =>
    form({ projectId: "p1", environmentId: "e1", serviceId });

  it("destroys a service this app created", async () => {
    const deleted: string[] = [];
    server.use(
      api.query("Project", () => HttpResponse.json({ data: projectWith() })),
      api.mutation("ServiceDelete", ({ variables }) => {
        deleted.push(variables.id as string);
        return HttpResponse.json({ data: { serviceDelete: true } });
      }),
    );

    const result = await spinDown(null, downForm("svc_managed"));

    expect(result).toEqual({ ok: true, message: "Destroyed cache" });
    expect(deleted).toEqual(["svc_managed"]);
  });

  it("refuses to destroy a service it did not create", async () => {
    /*
     * The load-bearing safety test. The user's own token would happily delete this
     * service; the refusal is ours, derived server-side, and cannot be bypassed by
     * posting a different serviceId from the client.
     */
    let deleteCalls = 0;
    server.use(
      api.query("Project", () => HttpResponse.json({ data: projectWith() })),
      api.mutation("ServiceDelete", () => {
        deleteCalls += 1;
        return HttpResponse.json({ data: { serviceDelete: true } });
      }),
    );

    const result = await spinDown(null, downForm("svc_foreign"));

    expect(result).toEqual({
      ok: false,
      error: "This service was not created here, so this app cannot act on it.",
    });
    expect(deleteCalls).toBe(0);
  });

  it("reports a service that has already gone and refreshes the list", async () => {
    server.use(api.query("Project", () => HttpResponse.json({ data: projectWith() })));

    const result = await spinDown(null, downForm("svc_missing"));

    expect(result).toEqual({ ok: false, error: "That container no longer exists." });
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard");
  });

  it("refuses an owned service posted against another environment", async () => {
    /*
     * Ownership is derived per environment — a service with no instance in the one
     * submitted does not appear in the list at all — while `serviceDelete` removes the
     * service from every environment at once. The check is therefore narrower than the
     * effect, and this is the case where that shows: `svc_managed` is genuinely ours,
     * but posted against `e2` it is unknown, and the action refuses rather than
     * reaching for the wider delete.
     */
    let deleteCalls = 0;
    server.use(
      api.query("Project", () => HttpResponse.json({ data: projectWith() })),
      api.mutation("ServiceDelete", () => {
        deleteCalls += 1;
        return HttpResponse.json({ data: { serviceDelete: true } });
      }),
    );

    const result = await spinDown(
      null,
      form({ projectId: "p1", environmentId: "e2", serviceId: "svc_managed" }),
    );

    expect(result).toEqual({ ok: false, error: "That container no longer exists." });
    expect(deleteCalls).toBe(0);
  });

  it("rejects a request with no service reference", async () => {
    const result = await spinDown(null, form({ projectId: "p1" }));
    expect(result).toEqual({ ok: false, error: "Missing container reference." });
  });

  it("maps a revoked authorization to a re-consent message", async () => {
    server.use(
      api.query("Project", () =>
        HttpResponse.json(
          { errors: [{ message: "nope", extensions: { code: "UNAUTHENTICATED" } }] },
          { status: 200 },
        ),
      ),
    );

    const result = await spinDown(null, downForm("svc_managed"));

    expect(result.ok).toBe(false);
    // A rejected credential, not a missing permission: the fix is signing in, and the
    // copy has to say so rather than sending the user to pick projects again.
    expect(!result.ok && result.error).toMatch(/signing in again/i);
  });

  it("propagates a delete failure as a readable message", async () => {
    server.use(
      api.query("Project", () => HttpResponse.json({ data: projectWith() })),
      api.mutation("ServiceDelete", () =>
        HttpResponse.json({ errors: [{ message: "Service is locked" }] }),
      ),
    );

    const result = await spinDown(null, downForm("svc_managed"));
    expect(result).toMatchObject({
      ok: false,
      // "Service is locked" names Railway's internal state; the user gets a reference
      // and the operator greps the log for it.
      error: expect.stringMatching(
        /^Railway refused this operation .* Reference [0-9a-f]{8}\.$/,
      ),
    });
  });

  describe("the stored data", () => {
    /* A body rather than a response, so each resolver keeps MSW's contextual typing. */
    const withVolume = (over: Record<string, unknown> = {}) => ({
      data: {
        environment: {
          id: "e1",
          volumeInstances: {
            edges: [
              {
                node: {
                  id: "volinst_1",
                  volumeId: "vol_1",
                  serviceId: "svc_managed",
                  mountPath: "/data",
                  sizeMB: 500,
                  currentSizeMB: 4,
                  ...over,
                },
              },
            ],
          },
        },
      },
    });

    /** The form the dialog posts with the checkbox left checked. */
    const withDeleteVolume = (serviceId: string) =>
      form({
        projectId: "p1",
        environmentId: "e1",
        serviceId,
        deleteData: "on",
      });

    it("deletes the volume when the box was checked, after the service", async () => {
      /*
       * Order is forced by Railway — it refuses to delete a volume still mounted on a live
       * service — and it is also the order that fails safe. Service first leaves at worst an
       * orphan the user can see in Railway's dashboard; volume first would at worst wipe the
       * data under a container that is still running.
       */
      const calls: string[] = [];
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        api.query("EnvironmentVolumes", () => HttpResponse.json(withVolume())),
        api.mutation("ServiceDelete", () => {
          calls.push("service");
          return HttpResponse.json({ data: { serviceDelete: true } });
        }),
        api.mutation("VolumeDelete", ({ variables }) => {
          calls.push(`volume:${variables.volumeId as string}`);
          return HttpResponse.json({ data: { volumeDelete: true } });
        }),
      );

      const result = await spinDown(null, withDeleteVolume("svc_managed"));

      expect(result).toEqual({
        ok: true,
        message: "Destroyed cache and its stored data",
      });
      expect(calls).toEqual(["service", "volume:vol_1"]);
    });

    it("keeps the volume when the box was not checked, and says so", async () => {
      /*
       * The sentence is the point, and it is why the volume read is unconditional. A kept
       * volume is billable storage that disappears from this UI along with its container —
       * the app lists containers, and an orphan volume is not one — so the outcome that
       * leaves a charge behind must not be the one that says nothing about it.
       */
      let volumeDeletes = 0;
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        api.query("EnvironmentVolumes", () => HttpResponse.json(withVolume())),
        api.mutation("ServiceDelete", () =>
          HttpResponse.json({ data: { serviceDelete: true } }),
        ),
        api.mutation("VolumeDelete", () => {
          volumeDeletes += 1;
          return HttpResponse.json({ data: { volumeDelete: true } });
        }),
      );

      const result = await spinDown(null, downForm("svc_managed"));

      expect(result).toEqual({
        ok: true,
        message:
          "Destroyed cache. Its data volume was kept and is still billed — remove it on Railway.",
      });
      expect(volumeDeletes).toBe(0);
    });

    it("never takes a volume id from the browser", async () => {
      /*
       * The client posts a boolean and a service id. A `volumeId` in the FormData is
       * ignored entirely and the id is read back from Railway — the same rule ownership and
       * the deployment id follow, and the reason is the same: a form that could name the
       * volume to delete would be a form that could name somebody else's.
       */
      let deleted: string | undefined;
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        api.query("EnvironmentVolumes", () => HttpResponse.json(withVolume())),
        api.mutation("ServiceDelete", () =>
          HttpResponse.json({ data: { serviceDelete: true } }),
        ),
        api.mutation("VolumeDelete", ({ variables }) => {
          deleted = variables.volumeId as string;
          return HttpResponse.json({ data: { volumeDelete: true } });
        }),
      );

      await spinDown(
        null,
        form({
          projectId: "p1",
          environmentId: "e1",
          serviceId: "svc_managed",
          deleteData: "on",
          volumeId: "vol_someone_elses",
        }),
      );

      expect(deleted).toBe("vol_1");
    });

    it("deletes no volume belonging to another service", async () => {
      // The join is `volumeInstance.serviceId`, and a volume mounted on a different
      // container in the same environment is not this container's to take.
      let volumeDeletes = 0;
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        api.query("EnvironmentVolumes", () =>
          HttpResponse.json(withVolume({ serviceId: "svc_other" })),
        ),
        api.mutation("ServiceDelete", () =>
          HttpResponse.json({ data: { serviceDelete: true } }),
        ),
        api.mutation("VolumeDelete", () => {
          volumeDeletes += 1;
          return HttpResponse.json({ data: { volumeDelete: true } });
        }),
      );

      const result = await spinDown(null, withDeleteVolume("svc_managed"));

      expect(volumeDeletes).toBe(0);
      /*
       * The plain sentence, not the "kept" one. No volume belongs to THIS container, so
       * there is nothing of its data left behind to warn about — the other service's volume
       * is still attached to a container the dashboard lists.
       */
      expect(result).toEqual({ ok: true, message: "Destroyed cache" });
    });

    it("deletes nothing, and claims nothing, when the volume read is refused", async () => {
      /*
       * `EnvironmentVolumes` degrades rather than throwing, and the destroy stays correct
       * through it in two halves. It deletes nothing, which is the conservative one; and it
       * says only "Destroyed", which is the honest one — with the read refused this app does
       * not know a volume exists, and claiming one was kept would be a statement it cannot
       * support. The same branch covers a volume Railway has not finished provisioning.
       *
       * README Limitations states what that leaves the user with, because it is a real gap
       * rather than a tidy one.
       */
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        api.query("EnvironmentVolumes", () =>
          HttpResponse.json({
            errors: [{ message: "Not Authorized", path: ["environment"] }],
          }),
        ),
        api.mutation("ServiceDelete", () =>
          HttpResponse.json({ data: { serviceDelete: true } }),
        ),
        api.mutation("VolumeDelete", () => {
          throw new Error("there is no volume this action knows about");
        }),
      );

      const result = await spinDown(null, withDeleteVolume("svc_managed"));

      expect(result).toEqual({ ok: true, message: "Destroyed cache" });
    });

    it("records what happened to the data, on both branches", async () => {
      /*
       * After `serviceDelete` Railway retains no record the container existed, so this line
       * is the only place the data's fate survives at all. Written whichever way it went —
       * a record that only appears on deletion cannot be read as "the volume was kept".
       */
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        api.query("EnvironmentVolumes", () => HttpResponse.json(withVolume())),
        api.mutation("ServiceDelete", () =>
          HttpResponse.json({ data: { serviceDelete: true } }),
        ),
        api.mutation("VolumeDelete", () =>
          HttpResponse.json({ data: { volumeDelete: true } }),
        ),
      );

      await spinDown(null, withDeleteVolume("svc_managed"));
      expect(logRecords().find((r) => r.msg === "container.destroyed")).toMatchObject({
        service_id: "svc_managed",
        volume_deleted: true,
        volume_id: "vol_1",
      });
    });

    it("refuses a service it did not create before reading any volume", async () => {
      // The ownership boundary is above all of this. A forged service id must not even
      // cause a volume read, let alone a delete.
      let volumeReads = 0;
      server.use(
        api.query("Project", () => HttpResponse.json({ data: projectWith() })),
        api.query("EnvironmentVolumes", () => {
          volumeReads += 1;
          return HttpResponse.json(withVolume());
        }),
        api.mutation("ServiceDelete", () => {
          throw new Error("must not delete an unmanaged service");
        }),
      );

      const result = await spinDown(null, withDeleteVolume("svc_foreign"));

      expect(result.ok).toBe(false);
      expect(volumeReads).toBe(0);
    });
  });
});

describe("spinDownMany", () => {
  const manyForm = (
    serviceIds: string[],
    over: Record<string, string> = {},
  ): FormData => {
    const data = form({ projectId: "p1", environmentId: "e1", ...over });
    for (const id of serviceIds) data.append("serviceId", id);
    return data;
  };

  /** Three of ours and the one this app did not create. */
  const mixedProject = () =>
    projectWith([
      { id: "svc_a", name: "spun-cache" },
      { id: "svc_b", name: "spun-queue" },
      { id: "svc_c", name: "spun-web" },
      { id: "svc_foreign", name: "postgres" },
    ]);

  it("destroys every service in the batch and says how many", async () => {
    const deleted: string[] = [];
    server.use(
      api.query("Project", () => HttpResponse.json({ data: mixedProject() })),
      api.mutation("ServiceDelete", ({ variables }) => {
        deleted.push(variables.id as string);
        return HttpResponse.json({ data: { serviceDelete: true } });
      }),
    );

    const result = await spinDownMany(null, manyForm(["svc_a", "svc_b"]));

    expect(result).toEqual({ ok: true, message: "Destroyed 2 containers" });
    expect(deleted).toEqual(["svc_a", "svc_b"]);
  });

  it("re-derives ownership per service, not per batch", async () => {
    /*
     * The load-bearing safety test, and the one the whole feature is bounded by. A batch is
     * a list of individual decisions taken against one read — never one decision about a
     * list — so a foreign service travelling alongside two of ours is refused on its own
     * while the other two go through.
     */
    const deleted: string[] = [];
    server.use(
      api.query("Project", () => HttpResponse.json({ data: mixedProject() })),
      api.mutation("ServiceDelete", ({ variables }) => {
        deleted.push(variables.id as string);
        return HttpResponse.json({ data: { serviceDelete: true } });
      }),
    );

    const result = await spinDownMany(
      null,
      manyForm(["svc_a", "svc_foreign", "svc_b"]),
    );

    expect(deleted).toEqual(["svc_a", "svc_b"]);
    expect(result).toEqual({
      ok: true,
      message:
        "Destroyed 2 of 3. The rest are still listed — they were already gone, were not created here, or Railway refused.",
    });
    expect(record("container.destroy_refused")).toMatchObject({
      reason: "unmanaged",
      service_id: "svc_foreign",
    });
  });

  it("reads the container list once for the whole batch", async () => {
    /*
     * The reason this is not `withManagedContainer` in a loop. Six services through the
     * singular helper would be six full project queries plus six volume reads, against a
     * quota Railway documents at 1,000 requests an hour.
     */
    let projectReads = 0;
    let volumeReads = 0;
    server.use(
      api.query("Project", () => {
        projectReads += 1;
        return HttpResponse.json({ data: mixedProject() });
      }),
      api.query("EnvironmentVolumes", () => {
        volumeReads += 1;
        return HttpResponse.json({
          data: { environment: { id: "e1", volumeInstances: { edges: [] } } },
        });
      }),
      api.mutation("ServiceDelete", () =>
        HttpResponse.json({ data: { serviceDelete: true } }),
      ),
    );

    await spinDownMany(null, manyForm(["svc_a", "svc_b", "svc_c"]));

    expect(projectReads).toBe(1);
    expect(volumeReads).toBe(1);
  });

  it("writes one audit line per service, never one naming the batch", async () => {
    /*
     * The moment this stopped being an audit trail and started being a counter would be a
     * single record listing six service ids. Once Railway has answered `serviceDelete` it
     * retains no record any of them existed.
     */
    server.use(
      api.query("Project", () => HttpResponse.json({ data: mixedProject() })),
      api.mutation("ServiceDelete", () =>
        HttpResponse.json({ data: { serviceDelete: true } }),
      ),
    );

    await spinDownMany(null, manyForm(["svc_a", "svc_b"]));

    const destroyed = logRecords().filter((r) => r.msg === "container.destroyed");
    expect(destroyed.map((r) => r.service_name)).toEqual(["spun-cache", "spun-queue"]);
  });

  it("skips a service that has already gone and destroys the rest", async () => {
    server.use(
      api.query("Project", () => HttpResponse.json({ data: mixedProject() })),
      api.mutation("ServiceDelete", () =>
        HttpResponse.json({ data: { serviceDelete: true } }),
      ),
    );

    const result = await spinDownMany(null, manyForm(["svc_a", "svc_gone"]));

    expect(result).toEqual({
      ok: true,
      message:
        "Destroyed 1 of 2. The rest are still listed — they were already gone, were not created here, or Railway refused.",
    });
    expect(record("container.destroy_skipped")).toMatchObject({
      reason: "gone",
      service_id: "svc_gone",
    });
  });

  it("carries on past a service Railway refuses, and names it", async () => {
    /*
     * The services already destroyed are gone whatever happens next, so abandoning the
     * batch would end the request with an error and no account of them at all.
     */
    const deleted: string[] = [];
    server.use(
      api.query("Project", () => HttpResponse.json({ data: mixedProject() })),
      api.mutation("ServiceDelete", ({ variables }) => {
        if (variables.id === "svc_b") {
          return HttpResponse.json({ errors: [{ message: "nope" }] }, { status: 500 });
        }
        deleted.push(variables.id as string);
        return HttpResponse.json({ data: { serviceDelete: true } });
      }),
    );

    const result = await spinDownMany(null, manyForm(["svc_a", "svc_b", "svc_c"]));

    expect(deleted).toEqual(["svc_a", "svc_c"]);
    expect(result.ok).toBe(true);
    expect(record("container.destroy_failed")).toMatchObject({
      service_id: "svc_b",
    });
  });

  it("fails the whole request when nothing in the batch could be destroyed", async () => {
    server.use(api.query("Project", () => HttpResponse.json({ data: mixedProject() })));

    const result = await spinDownMany(null, manyForm(["svc_foreign", "svc_gone"]));

    expect(result).toEqual({
      ok: false,
      error:
        "None of the 2 containers could be destroyed. They were already gone, were not created here, or Railway refused.",
    });
  });

  it("destroys a repeated service id once rather than reporting a failure", async () => {
    // A shape no browser produces and a hand-written form does: destroying it twice would
    // make the batch lie about its own outcome.
    const deleted: string[] = [];
    server.use(
      api.query("Project", () => HttpResponse.json({ data: mixedProject() })),
      api.mutation("ServiceDelete", ({ variables }) => {
        deleted.push(variables.id as string);
        return HttpResponse.json({ data: { serviceDelete: true } });
      }),
    );

    const result = await spinDownMany(null, manyForm(["svc_a", "svc_a"]));

    expect(deleted).toEqual(["svc_a"]);
    expect(result).toEqual({ ok: true, message: "Destroyed 1 container" });
  });

  it("refuses an oversized batch before it reads anything", async () => {
    let projectReads = 0;
    let deleteCalls = 0;
    server.use(
      api.query("Project", () => {
        projectReads += 1;
        return HttpResponse.json({ data: mixedProject() });
      }),
      api.mutation("ServiceDelete", () => {
        deleteCalls += 1;
        return HttpResponse.json({ data: { serviceDelete: true } });
      }),
    );

    const ids = Array.from(
      { length: LIMITS.BULK_DESTROY_MAX + 1 },
      (_, i) => `svc_${i}`,
    );
    const result = await spinDownMany(null, manyForm(ids));

    expect(result).toEqual({
      ok: false,
      error: `Select at most ${LIMITS.BULK_DESTROY_MAX} containers to destroy at once.`,
    });
    // The ceiling protects the quota, so it has to bite before anything is spent on it.
    expect(projectReads).toBe(0);
    expect(deleteCalls).toBe(0);
  });

  it("rejects a request naming no service at all", async () => {
    const result = await spinDownMany(null, manyForm([]));
    expect(result.ok).toBe(false);
  });

  describe("the stored data", () => {
    const volumesFor = (serviceIds: string[]) => ({
      data: {
        environment: {
          id: "e1",
          volumeInstances: {
            edges: serviceIds.map((serviceId, index) => ({
              node: {
                id: `volinst_${index}`,
                volumeId: `vol_${index}`,
                serviceId,
                mountPath: "/data",
                sizeMB: 500,
                currentSizeMB: 4,
              },
            })),
          },
        },
      },
    });

    it("deletes every volume in the batch when the box was ticked", async () => {
      const volumesDeleted: string[] = [];
      server.use(
        api.query("Project", () => HttpResponse.json({ data: mixedProject() })),
        api.query("EnvironmentVolumes", () =>
          HttpResponse.json(volumesFor(["svc_a", "svc_b"])),
        ),
        api.mutation("ServiceDelete", () =>
          HttpResponse.json({ data: { serviceDelete: true } }),
        ),
        api.mutation("VolumeDelete", ({ variables }) => {
          volumesDeleted.push(variables.volumeId as string);
          return HttpResponse.json({ data: { volumeDelete: true } });
        }),
      );

      await spinDownMany(null, manyForm(["svc_a", "svc_b"], { deleteData: "on" }));

      expect(volumesDeleted).toEqual(["vol_0", "vol_1"]);
    });

    it("keeps every volume when it was not", async () => {
      let volumeDeletes = 0;
      server.use(
        api.query("Project", () => HttpResponse.json({ data: mixedProject() })),
        api.query("EnvironmentVolumes", () =>
          HttpResponse.json(volumesFor(["svc_a", "svc_b"])),
        ),
        api.mutation("ServiceDelete", () =>
          HttpResponse.json({ data: { serviceDelete: true } }),
        ),
        api.mutation("VolumeDelete", () => {
          volumeDeletes += 1;
          return HttpResponse.json({ data: { volumeDelete: true } });
        }),
      );

      // Unticked is the default here, unlike the single destroy: one tick covers containers
      // whose volumes the reader has not seen individually.
      await spinDownMany(null, manyForm(["svc_a", "svc_b"]));

      expect(volumeDeletes).toBe(0);
      expect(record("container.destroyed")).toMatchObject({ volume_deleted: false });
    });

    it("leaves a container without a volume alone", async () => {
      const volumesDeleted: string[] = [];
      server.use(
        api.query("Project", () => HttpResponse.json({ data: mixedProject() })),
        api.query("EnvironmentVolumes", () => HttpResponse.json(volumesFor(["svc_a"]))),
        api.mutation("ServiceDelete", () =>
          HttpResponse.json({ data: { serviceDelete: true } }),
        ),
        api.mutation("VolumeDelete", ({ variables }) => {
          volumesDeleted.push(variables.volumeId as string);
          return HttpResponse.json({ data: { volumeDelete: true } });
        }),
      );

      await spinDownMany(null, manyForm(["svc_a", "svc_b"], { deleteData: "on" }));

      expect(volumesDeleted).toEqual(["vol_0"]);
    });
  });
});

/**
 * Stop, restart and redeploy.
 *
 * They post the same three ids `spinDown` does and run through the same ownership
 * re-derivation, so the cases that matter are per verb rather than shared: which mutation
 * reaches Railway, which deployment id it carries, and that an unmanaged service reaches
 * none of them. The refusal test is repeated for each deliberately — it is the one property
 * this whole feature is bounded by, and a shared helper asserting it once would let a verb
 * be added that skips the guard while the suite stayed green.
 */
