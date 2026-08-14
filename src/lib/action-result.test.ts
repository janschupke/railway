import { describe, expect, it } from "vitest";
import { describeActionError, isField } from "./action-result";
import { SessionExpiredError } from "./auth/refresh";
import { RailwayApiError } from "./railway/errors";
import messages from "../../messages/en.json";

/** Walks the catalog with a dotted key, so a descriptor can be checked end to end. */
function lookup(key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      messages,
    );
}

describe("describeActionError", () => {
  it("tells an expired session to sign in again", () => {
    expect(describeActionError(new SessionExpiredError())).toEqual({
      key: "errors.sessionExpired",
    });
  });

  it("replaces Railway's own text with a reference to the log line holding it", () => {
    /*
     * Railway's GraphQL text names internal fields, and on a schema rejection it
     * quotes the document we sent. It used to be interpolated into the sentence; now
     * it goes to the log and the user carries the id that points at it.
     */
    const descriptor = describeActionError(
      new RailwayApiError("Service 8f2c not found on project prj_internal", {
        kind: "graphql",
      }),
    );

    expect(descriptor.key).toBe("errors.api.graphqlUnexpected");
    expect(descriptor.values?.incident).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(descriptor)).not.toContain("prj_internal");
  });

  it("says a schema rejection is one, without quoting the query", () => {
    const descriptor = describeActionError(
      new RailwayApiError('Cannot query field "workspaces" on type "User"', {
        kind: "graphql",
        code: "GRAPHQL_VALIDATION_FAILED",
      }),
    );

    // A different problem from "Railway refused the operation", and the user can act
    // on it differently — so it gets its own wording rather than only a log tag.
    expect(descriptor.key).toBe("errors.api.graphqlSchema");
    expect(JSON.stringify(descriptor)).not.toContain("workspaces");
  });

  it("carries the retry delay as a value, so the catalog can pluralise it", () => {
    expect(
      describeActionError(
        new RailwayApiError("429", { kind: "rate_limit", retryAfterSeconds: 12 }),
      ),
    ).toMatchObject({ key: "errors.api.rateLimitRetry", values: { seconds: 12 } });
  });

  it("does not leak an unexpected error's message to the UI", () => {
    // An internal stack or token fragment must never reach the browser.
    const descriptor = describeActionError(
      new Error("connect ECONNREFUSED 10.0.0.1:5432"),
    );
    expect(descriptor.key).toBe("errors.generic");
    expect(JSON.stringify(descriptor)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(descriptor)).not.toContain("10.0.0.1");
  });

  it("handles non-Error throws", () => {
    expect(describeActionError("boom").key).toBe("errors.generic");
    expect(describeActionError(undefined).key).toBe("errors.generic");
  });

  it("names keys that actually exist in the catalog", () => {
    /*
     * The descriptor indirection buys type-checked keys at the call sites, but nothing
     * would catch a key that was renamed in the catalog only. This closes that gap for
     * every error path at once.
     */
    const cases: unknown[] = [
      new SessionExpiredError(),
      new Error("boom"),
      "not an error",
      new RailwayApiError("x", { kind: "auth" }),
      new RailwayApiError("x", { kind: "network" }),
      new RailwayApiError("x", { kind: "server" }),
      new RailwayApiError("x", { kind: "graphql" }),
      new RailwayApiError("", { kind: "graphql" }),
      new RailwayApiError("x", { kind: "rate_limit" }),
      new RailwayApiError("x", { kind: "rate_limit", retryAfterSeconds: 5 }),
    ];

    for (const input of cases) {
      const { key } = describeActionError(input);
      expect(lookup(key), key).toBeTypeOf("string");
    }
  });
});

describe("isField", () => {
  it("recognises every attributable field", () => {
    expect(isField("name")).toBe(true);
    expect(isField("image")).toBe(true);
    expect(isField("variableKey")).toBe(true);
    expect(isField("variableValue")).toBe(true);
  });

  it("rejects anything else, including zod's numeric array indices", () => {
    /*
     * The numeric case stopped being hypothetical with T-487: a repeated field's issue
     * path is ["variableKey", 3], so an index is now genuinely passed through here.
     */
    expect(isField("projectId")).toBe(false);
    expect(isField("variables")).toBe(false);
    expect(isField(0)).toBe(false);
    expect(isField(3)).toBe(false);
    expect(isField(undefined)).toBe(false);
  });
});
