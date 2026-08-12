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

  it("wraps a Railway GraphQL message rather than surfacing it bare", () => {
    // Railway's own text is English and untranslatable; the sentence around it is not.
    expect(
      describeActionError(
        new RailwayApiError("Service not found", { kind: "graphql" }),
      ),
    ).toEqual({
      key: "errors.api.graphqlDetail",
      values: { detail: "Service not found" },
    });
  });

  it("carries the retry delay as a value, so the catalog can pluralise it", () => {
    expect(
      describeActionError(
        new RailwayApiError("429", { kind: "rate_limit", retryAfterSeconds: 12 }),
      ),
    ).toEqual({ key: "errors.api.rateLimitRetry", values: { seconds: 12 } });
  });

  it("does not leak an unexpected error's message to the UI", () => {
    // An internal stack or token fragment must never reach the browser.
    const descriptor = describeActionError(
      new Error("connect ECONNREFUSED 10.0.0.1:5432"),
    );
    expect(descriptor).toEqual({ key: "errors.generic" });
    expect(JSON.stringify(descriptor)).not.toContain("ECONNREFUSED");
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
  it("recognises the two attributable fields", () => {
    expect(isField("name")).toBe(true);
    expect(isField("image")).toBe(true);
  });

  it("rejects anything else, including zod's numeric array indices", () => {
    expect(isField("projectId")).toBe(false);
    expect(isField(0)).toBe(false);
    expect(isField(undefined)).toBe(false);
  });
});
