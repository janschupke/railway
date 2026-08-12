import { describe, expect, it } from "vitest";
import { logRecords, rawLogLines } from "@/test/log-capture";
import { RailwayApiError } from "@/lib/railway/errors";
import { reportError } from "./report-error";

const only = () => {
  const records = logRecords();
  expect(records).toHaveLength(1);
  return records[0]! as Record<string, unknown> & { err?: Record<string, unknown> };
};

describe("reportError", () => {
  it("keeps the upstream text in the log and out of the descriptor", () => {
    // The whole point of the module: one direction for detail, the other for copy.
    const descriptor = reportError(
      "railway.logBackfill",
      new RailwayApiError('Cannot query field "workspaces" on type "User"', {
        kind: "graphql",
        operation: "Projects",
        code: "GRAPHQL_VALIDATION_FAILED",
      }),
      "errors.generic",
    );

    expect(JSON.stringify(descriptor)).not.toContain("workspaces");

    const record = only();
    expect(record.err?.message).toContain("workspaces");
    expect(record.err?.operation).toBe("Projects");
    expect(record.err?.schema_rejection).toBe(true);
    expect(record.level).toBe("error");
  });

  it("logs under the same id the user is shown", () => {
    // Without this the reference is decorative — a screenshot has to find its log line.
    const error = new RailwayApiError("boom", { kind: "graphql" });
    const descriptor = reportError("dashboard", error, "errors.generic");

    expect(descriptor.values?.incident).toBe(error.incidentId);
    expect(only().incident).toBe(error.incidentId);
  });

  it("names the refused field and the scope it implies", () => {
    /*
     * The difference between a dead token and a scope that was never granted. It reaches
     * the browser as advice ("approve workspace:viewer"); the log needs the path that
     * advice was derived from, or the advice cannot be checked.
     */
    reportError(
      "dashboard",
      new RailwayApiError("Not Authorized", {
        kind: "auth",
        path: ["me", "workspaces"],
      }),
      "errors.generic",
    );

    const record = only();
    expect(record.err?.path).toBe("me.workspaces");
    expect(record.err?.missing_scope).toBe("workspace:viewer");
  });

  it("does not leak a transport error's address", () => {
    // `ws` failures carry the resolved host and port; this one reached a Banner.
    const descriptor = reportError(
      "railway.logStream",
      new Error("connect ECONNREFUSED 10.0.0.4:443"),
      "errors.streamInterrupted",
    );

    expect(descriptor.key).toBe("errors.streamInterrupted");
    expect(JSON.stringify(descriptor)).not.toContain("10.0.0.4");
    expect(only().err?.message).toContain("10.0.0.4");
  });

  it("never writes a credential a failure was constructed around", () => {
    /*
     * RailwayApiError assigns `this.cause`, and `cause` is an enumerable own property.
     * Anything that stringifies an error wholesale emits it, which is how a token
     * response reaches a retained log. Asserted over the raw written bytes.
     */
    reportError(
      "railway.deploymentPoll",
      new RailwayApiError("boom", {
        kind: "network",
        cause: { access_token: "AT-CANARY" },
      }),
      "errors.generic",
    );

    expect(rawLogLines().join("")).not.toContain("AT-CANARY");
  });

  it("mints an id for a failure that carries none", () => {
    const descriptor = reportError("action", "boom", "errors.generic");
    expect(descriptor.values?.incident).toMatch(/^[0-9a-f]{8}$/);
  });

  it("names the scope, so the log is queryable by subsystem", () => {
    reportError("railway.deploymentPoll", new Error("x"), "errors.generic");
    expect(only().msg).toBe("railway.deploymentPoll");
  });
});
