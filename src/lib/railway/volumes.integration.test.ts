/**
 * An environment's volumes: the degrading read, and the mutation that is not.
 */

import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { logRecords } from "@/test/log-capture";
import { TOKEN, railwayApi, setupRailwayServer } from "@/test/railway-msw";
import { deleteVolume, getEnvironmentVolumes } from "./volumes";
import { railwayApiUrl } from "./client";

const api = railwayApi(railwayApiUrl());
const server = setupRailwayServer();

describe("getEnvironmentVolumes", () => {
  /* A body rather than a response, so each resolver keeps MSW's contextual typing — the
     same reason `notAuthorized` at the top of this file is written that way. */
  const instances = (nodes: Array<Record<string, unknown>>) => ({
    data: {
      environment: {
        id: "e1",
        volumeInstances: { edges: nodes.map((node) => ({ node })) },
      },
    },
  });

  it("keys the volumes by the service each is mounted on", async () => {
    server.use(
      api.query("EnvironmentVolumes", () =>
        HttpResponse.json(
          instances([
            {
              id: "volinst_1",
              volumeId: "vol_1",
              serviceId: "svc_1",
              mountPath: "/data",
              sizeMB: 500,
              currentSizeMB: 3,
            },
          ]),
        ),
      ),
    );

    await expect(getEnvironmentVolumes(TOKEN, "e1")).resolves.toEqual({
      svc_1: {
        serviceId: "svc_1",
        volumeId: "vol_1",
        mountPath: "/data",
        sizeMB: 500,
        currentSizeMB: 3,
      },
    });
  });

  it("degrades to nothing when Railway refuses it, rather than throwing", async () => {
    /*
     * `EnvironmentVolumes` is in DEGRADING_OPERATIONS, and this is what makes that safe:
     * every consequence of the empty answer is the conservative one. The row shows no
     * volume, the destroy dialog offers no choice, and the data is kept — and the toast
     * says it was kept, so the outcome is visible rather than silent.
     */
    server.use(
      api.query("EnvironmentVolumes", () =>
        // `errors` alone, with no `data` member: that is the body Railway sends, and it is
        // also the only shape MSW's GraphQL resolver types accept.
        HttpResponse.json({
          errors: [{ message: "Not Authorized", path: ["environment"] }],
        }),
      ),
    );

    await expect(getEnvironmentVolumes(TOKEN, "e1")).resolves.toEqual({});

    // Debug rather than warn: this read runs on every dashboard render, and a token that
    // will never hold the scope would otherwise write a warn per render, forever.
    expect(logRecords().find((r) => r.msg === "railway.volumes.refused")).toMatchObject(
      {
        environment_id: "e1",
        level: "debug",
      },
    );
  });
});
describe("deleteVolume", () => {
  it("sends the volume id, not the instance id", async () => {
    // `volumeDelete` takes the Volume's id; `VolumeInstance.id` is a different value on the
    // same response, and sending it is a 'not found' that reads like a missing volume.
    let seen: string | undefined;
    server.use(
      api.mutation("VolumeDelete", ({ variables }) => {
        seen = variables.volumeId as string;
        return HttpResponse.json({ data: { volumeDelete: true } });
      }),
    );

    await deleteVolume(TOKEN, "vol_1");
    expect(seen).toBe("vol_1");
  });
});
