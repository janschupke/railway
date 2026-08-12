import { describe, expect, it } from "vitest";
import { RailwayApiError } from "@/lib/railway/errors";
import { SessionExpiredError } from "@/lib/auth/refresh";
import { errorFields } from "./serialize-error";

describe("errorFields", () => {
  /*
   * The reason this module exists. pino's stock `err` serializer walks `cause`, and both
   * error classes in this app assign it — so a default setup would have re-opened the
   * token leak the security review closed. Each case below plants a canary in a place a
   * naive serializer reaches.
   */
  describe("never reads cause", () => {
    it("drops it from a plain Error", () => {
      const error = new Error("token exchange failed", {
        cause: { body: { access_token: "AT-CANARY", refresh_token: "RT-CANARY" } },
      });

      const serialized = JSON.stringify(errorFields(error));

      expect(serialized).not.toContain("AT-CANARY");
      expect(serialized).not.toContain("RT-CANARY");
      expect(serialized).not.toContain("cause");
    });

    it("drops it from a RailwayApiError", () => {
      const error = new RailwayApiError("boom", {
        kind: "network",
        cause: { refresh_token: "RT-CANARY" },
      });

      expect(JSON.stringify(errorFields(error))).not.toContain("RT-CANARY");
    });

    it("drops it from a SessionExpiredError", () => {
      // refresh.ts preserves the raw openid-client error here, and that error is the one
      // oauth4webapi attaches a parsed token response to.
      const error = new SessionExpiredError({
        claims: { email: "user@example.com" },
        access_token: "AT-CANARY",
      });

      const serialized = JSON.stringify(errorFields(error));

      expect(serialized).not.toContain("AT-CANARY");
      expect(serialized).not.toContain("user@example.com");
    });
  });

  it("promotes a RailwayApiError's fields instead of flattening them into prose", () => {
    // These were computed and then interpolated into a template string only grep could
    // read. As fields they are queryable, which is the point of the change.
    const error = new RailwayApiError(
      'Cannot query field "workspaces" on type "User"',
      {
        kind: "graphql",
        status: 200,
        operation: "Projects",
        code: "GRAPHQL_VALIDATION_FAILED",
        path: ["me", "workspaces"],
      },
    );

    expect(errorFields(error)).toMatchObject({
      type: "RailwayApiError",
      kind: "graphql",
      status: 200,
      operation: "Projects",
      code: "GRAPHQL_VALIDATION_FAILED",
      path: "me.workspaces",
      schema_rejection: true,
      incident: error.incidentId,
    });
  });

  it("names the scope a refused field implies", () => {
    const error = new RailwayApiError("Not Authorized", {
      kind: "auth",
      path: ["me", "workspaces"],
    });

    expect(errorFields(error).missing_scope).toBe("workspace:viewer");
  });

  it("omits absent fields rather than emitting undefined", () => {
    const fields = errorFields(new RailwayApiError("boom", { kind: "network" }));

    expect(Object.keys(fields)).not.toContain("operation");
    expect(Object.keys(fields)).not.toContain("status");
    expect(Object.keys(fields)).not.toContain("schema_rejection");
  });

  it("keeps the stack for an unclassified error, where it is the only diagnosis", () => {
    expect(errorFields(new Error("boom")).stack).toContain("boom");
  });

  it("drops the stack for a RailwayApiError, whose frames name our own mapper", () => {
    // ~700 bytes a record on the noisiest warn path, pointing at client.ts every time.
    // The promoted fields are the diagnosis; that is why they are promoted.
    const fields = errorFields(new RailwayApiError("boom", { kind: "network" }));

    expect(fields.stack).toBeUndefined();
    expect(fields.kind).toBe("network");
  });

  it("refuses to stringify an object that is not an Error", () => {
    /*
     * `String({...})` is "[object Object]" on a good day and a JSON blob on a bad one.
     * A raw token response reaching here by mistake must not be readable either way.
     */
    expect(errorFields({ access_token: "AT-CANARY" })).toEqual({
      type: "unknown",
      message: "[non-error object]",
    });
  });

  it("keeps a thrown primitive, whose string form is the whole value", () => {
    expect(errorFields("boom")).toEqual({ type: "unknown", message: "boom" });
    expect(errorFields(undefined)).toEqual({ type: "unknown", message: "undefined" });
  });
});
