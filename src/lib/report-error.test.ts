import { afterEach, describe, expect, it, vi } from "vitest";
import { RailwayApiError } from "@/lib/railway/errors";
import { reportError } from "./report-error";

const logged = vi.spyOn(console, "error").mockImplementation(() => {});

afterEach(() => logged.mockClear());

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
    expect(logged.mock.calls[0]?.[0]).toContain("workspaces");
    expect(logged.mock.calls[0]?.[0]).toContain("op=Projects");
    expect(logged.mock.calls[0]?.[0]).toContain("schemaRejection");
  });

  it("logs under the same id the user is shown", () => {
    // Without this the reference is decorative — a screenshot has to find its log line.
    const error = new RailwayApiError("boom", { kind: "graphql" });
    const descriptor = reportError("dashboard", error, "errors.generic");

    expect(descriptor.values?.incident).toBe(error.incidentId);
    expect(logged.mock.calls[0]?.[0]).toContain(error.incidentId);
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
    expect(logged.mock.calls[0]?.[0]).toContain("10.0.0.4");
  });

  it("mints an id for a failure that carries none", () => {
    const descriptor = reportError("action", "boom", "errors.generic");
    expect(descriptor.values?.incident).toMatch(/^[0-9a-f]{8}$/);
  });

  it("names the scope, so the log is greppable by subsystem", () => {
    reportError("railway.deploymentPoll", new Error("x"), "errors.generic");
    expect(logged.mock.calls[0]?.[0]).toContain("railway.deploymentPoll");
  });
});
