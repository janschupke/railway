import { describe, expect, it } from "vitest";
import { isField, toActionError } from "./action-result";
import { SessionExpiredError } from "./auth/refresh";
import { RailwayApiError } from "./railway/errors";

describe("toActionError", () => {
  it("tells an expired session to sign in again", () => {
    const result = toActionError(new SessionExpiredError());
    expect(result).toEqual({
      ok: false,
      error: "Your Railway session expired. Sign in again.",
    });
  });

  it("passes through a Railway error's user-facing message", () => {
    const result = toActionError(
      new RailwayApiError("Service not found", { kind: "graphql" }),
    );
    expect(result).toEqual({ ok: false, error: "Service not found" });
  });

  it("uses the rate-limit wording, including the retry delay", () => {
    const result = toActionError(
      new RailwayApiError("429", { kind: "rate_limit", retryAfterSeconds: 12 }),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("12s");
  });

  it("does not leak an unexpected error's message to the UI", () => {
    // An internal stack or token fragment must never reach the browser.
    const result = toActionError(new Error("connect ECONNREFUSED 10.0.0.1:5432"));
    expect(result).toEqual({
      ok: false,
      error: "Something went wrong. Please try again.",
    });
  });

  it("handles non-Error throws", () => {
    expect(toActionError("boom").ok).toBe(false);
    expect(toActionError(undefined).ok).toBe(false);
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
