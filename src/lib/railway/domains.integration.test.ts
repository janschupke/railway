/**
 * Minting a public domain for a service that already exists.
 */

import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { TOKEN, railwayApi, setupRailwayServer } from "@/test/railway-msw";
import { createServiceDomain } from "./domains";
import { railwayApiUrl } from "./client";

const api = railwayApi(railwayApiUrl());
const server = setupRailwayServer();

describe("createServiceDomain", () => {
  it("omits targetPort entirely when the caller has none", async () => {
    /*
     * Omitted rather than sent as null. Both mean "infer from the deployment" to Railway,
     * but an explicit null reads as a decision — and the row control reaching this branch
     * has no port to decide with, because the catalog does not know the image.
     */
    let input: Record<string, unknown> | undefined;
    server.use(
      api.mutation("ServiceDomainCreate", ({ variables }) => {
        input = variables.input as Record<string, unknown>;
        return HttpResponse.json({
          data: {
            serviceDomainCreate: {
              id: "dom_1",
              domain: "spun-x-production.up.railway.app",
              targetPort: null,
            },
          },
        });
      }),
    );

    const url = await createServiceDomain(TOKEN, {
      environmentId: "e1",
      serviceId: "svc_1",
    });

    expect(input).toEqual({ environmentId: "e1", serviceId: "svc_1" });
    expect("targetPort" in (input ?? {})).toBe(false);
    expect(url).toBe("https://spun-x-production.up.railway.app");
  });

  it("throws on a refusal, because the whole of its action is this call", async () => {
    server.use(
      api.mutation("ServiceDomainCreate", () =>
        HttpResponse.json({ errors: [{ message: "Not Authorized" }] }),
      ),
    );

    await expect(
      createServiceDomain(TOKEN, { environmentId: "e1", serviceId: "svc_1" }),
    ).rejects.toThrow();
  });
});
