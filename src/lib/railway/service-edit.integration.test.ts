/**
 * Changing a container that exists, and reading which variables it has.
 *
 * The read is here rather than with the other reads for the reason its module gives: it
 * exists for the edit form and for nothing else, and the two share the rule that a name the
 * schema refuses on the way in is not worth a row on the way out.
 */

import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { logRecords, rawLogLines } from "@/test/log-capture";
import { TOKEN, railwayApi, setupRailwayServer } from "@/test/railway-msw";
import { readServiceVariableNames, updateContainer } from "./service-edit";
import { railwayApiUrl } from "./client";

const api = railwayApi(railwayApiUrl());
const server = setupRailwayServer();

describe("readServiceVariableNames", () => {
  /** The two aliased reads the document performs, in one handler. */
  const variables = (
    service: Record<string, string>,
    shared: Record<string, string> = {},
  ) =>
    api.query("ServiceVariables", () =>
      HttpResponse.json({ data: { service, shared } }),
    );

  const read = () =>
    readServiceVariableNames(TOKEN, {
      projectId: "p1",
      environmentId: "e1",
      serviceId: "svc_1",
    });

  it("returns names and never values", async () => {
    /*
     * The security property of this function, asserted rather than assumed. The return type
     * says `string[]`, but a mapper that returned entries would also compile — so the test
     * is over the *values*, which is what must never reach a caller and therefore a browser.
     */
    server.use(variables({ POSTGRES_PASSWORD: "hunter2", PORT: "5432" }));

    const names = await read();

    expect(names).toEqual(["PORT", "POSTGRES_PASSWORD"]);
    expect(JSON.stringify(names)).not.toContain("hunter2");
  });

  it("drops variables the environment shares with every service", async () => {
    // Not this service's to edit, and not something variableDelete could remove for it.
    server.use(variables({ OWN: "a", SHARED_TOKEN: "s" }, { SHARED_TOKEN: "s" }));

    expect(await read()).toEqual(["OWN"]);
  });

  it("keeps a shared name the service overrides with its own value", async () => {
    /*
     * The reason the subtraction is by name *and* value. A service is allowed to override a
     * shared name, and that override is genuinely the service's — dropping it by name would
     * hide a variable from its own editor, and the next save would then delete it.
     */
    server.use(variables({ SHARED_TOKEN: "mine" }, { SHARED_TOKEN: "theirs" }));

    expect(await read()).toEqual(["SHARED_TOKEN"]);
  });

  it("drops the namespace Railway sets itself", async () => {
    // The schemas refuse these on the way in, so a row for one could never be submitted.
    server.use(variables({ RAILWAY_PRIVATE_DOMAIN: "x", KEEP: "y" }));

    expect(await read()).toEqual(["KEEP"]);
  });
});
describe("updateContainer", () => {
  const target = {
    projectId: "p1",
    environmentId: "e1",
    serviceId: "svc_1",
  };

  it("sends nothing at all when nothing changed", async () => {
    /*
     * No handlers registered, and `onUnhandledRequest: "error"` is what makes that an
     * assertion: any request here fails the test. A form submitted untouched is something
     * people do, and it must not cost a redeploy.
     */
    const result = await updateContainer(TOKEN, target);

    expect(result).toEqual({ deploymentId: null, outcome: "unchanged" });
  });

  it("renames through serviceUpdate, which is not the instance mutation", async () => {
    /*
     * The correction this ticket turned on. `ServiceInstanceUpdateInput` has no `name`
     * member and never had one — the name lives on `Service` — so a rename that went through
     * serviceInstanceUpdate would be a document that does not validate, and one that sent
     * `name` inside `source` would be silently ignored by Railway.
     */
    let sent: Record<string, unknown> | undefined;
    server.use(
      api.mutation("ServiceUpdate", ({ variables }) => {
        sent = variables;
        return HttpResponse.json({
          data: { serviceUpdate: { id: "svc_1", name: "spun-renamed" } },
        });
      }),
    );

    const result = await updateContainer(TOKEN, { ...target, name: "spun-renamed" });

    expect(sent).toEqual({ id: "svc_1", input: { name: "spun-renamed" } });
    // A rename changes nothing about the running container, so nothing is redeployed.
    expect(result).toEqual({ deploymentId: null, outcome: "updated" });
  });

  it("changes the image and redeploys, returning the new deployment to stream", async () => {
    const calls: string[] = [];
    let sent: Record<string, unknown> | undefined;
    server.use(
      api.mutation("ServiceInstanceUpdate", ({ variables }) => {
        calls.push("image");
        sent = variables;
        return HttpResponse.json({ data: { serviceInstanceUpdate: true } });
      }),
      api.mutation("ServiceInstanceDeployV2", () => {
        calls.push("deploy");
        return HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_2" } });
      }),
    );

    const result = await updateContainer(TOKEN, { ...target, image: "postgres:17" });

    expect(calls).toEqual(["image", "deploy"]);
    expect(sent).toEqual({
      serviceId: "svc_1",
      environmentId: "e1",
      // `source` alone. Every other member of the input is a feature with its own ticket,
      // and sending one would overwrite a setting nobody asked this form about.
      input: { source: { image: "postgres:17" } },
    });
    expect(result).toEqual({ deploymentId: "dep_2", outcome: "deployed" });
  });

  it("deletes removed variables before writing the rest, then deploys", async () => {
    /*
     * Order twice over. Deletes precede the upsert so a row renamed in the editor cannot
     * have its delete land after its write; the whole variable block precedes the deploy for
     * the reason createContainer gives — a container that boots without the variable it
     * needs crash-loops in front of the user.
     */
    const calls: string[] = [];
    const deleted: string[] = [];
    let upserted: Record<string, unknown> | undefined;
    server.use(
      api.mutation("VariableDelete", ({ variables }) => {
        calls.push("delete");
        deleted.push((variables.input as { name: string }).name);
        return HttpResponse.json({ data: { variableDelete: true } });
      }),
      api.mutation("VariableCollectionUpsert", ({ variables }) => {
        calls.push("upsert");
        upserted = variables.input as Record<string, unknown>;
        return HttpResponse.json({ data: { variableCollectionUpsert: 1 } });
      }),
      api.mutation("ServiceInstanceDeployV2", () => {
        calls.push("deploy");
        return HttpResponse.json({ data: { serviceInstanceDeployV2: "dep_3" } });
      }),
    );

    const result = await updateContainer(TOKEN, {
      ...target,
      variables: { KEPT: "new" },
      removeVariables: ["GONE", "ALSO_GONE"],
    });

    expect(calls).toEqual(["delete", "delete", "upsert", "deploy"]);
    expect(deleted).toEqual(["GONE", "ALSO_GONE"]);
    /*
     * `replace: false` even on an edit, where the service does have variables to replace.
     * Removal is per-key above, so `replace: true` would add only the power to delete
     * something the read failed to report — the one failure with no way back.
     */
    expect(upserted).toMatchObject({ replace: false, skipDeploys: true });
    expect(result).toEqual({ deploymentId: "dep_3", outcome: "deployed" });
  });

  it("reports a refused variable change without deploying, and logs no value", async () => {
    server.use(
      api.mutation("VariableCollectionUpsert", () =>
        HttpResponse.json({ errors: [{ message: "Not Authorized" }] }),
      ),
    );

    const result = await updateContainer(TOKEN, {
      ...target,
      variables: { SECRET: "hunter2" },
    });

    expect(result).toEqual({ deploymentId: null, outcome: "variables_failed" });

    const record = logRecords().find((r) => r.msg === "railway.variables_failed");
    expect(record).toMatchObject({ service_id: "svc_1", variable_count: 1 });
    // The count carries the diagnostic content; the names and values carry none of it.
    expect(rawLogLines().join("\n")).not.toContain("hunter2");
    expect(rawLogLines().join("\n")).not.toContain("SECRET");
  });

  it("reports a refused deploy after the change has already landed", async () => {
    /*
     * Caught rather than thrown, exactly as in createContainer: the image has changed by
     * this point, so a throw would lose which half succeeded and the user would be told
     * nothing happened when something did.
     */
    server.use(
      api.mutation("ServiceInstanceUpdate", () =>
        HttpResponse.json({ data: { serviceInstanceUpdate: true } }),
      ),
      api.mutation("ServiceInstanceDeployV2", () =>
        HttpResponse.json({ errors: [{ message: "Nope" }] }),
      ),
    );

    const result = await updateContainer(TOKEN, { ...target, image: "postgres:17" });

    expect(result).toEqual({ deploymentId: null, outcome: "deploy_failed" });
  });

  it("throws when the rename is refused, because nothing has changed yet", async () => {
    // The other half of that split. No mutation has landed, so the honest answer is the
    // error and a form the user can resubmit.
    server.use(
      api.mutation("ServiceUpdate", () =>
        HttpResponse.json({ errors: [{ message: "Nope" }] }),
      ),
    );

    await expect(
      updateContainer(TOKEN, { ...target, name: "spun-taken" }),
    ).rejects.toThrow();
  });
});
