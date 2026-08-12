import { describe, expect, it } from "vitest";
import {
  REQUEST_ID_PATTERN,
  newRequestId,
  requestContext,
  runWithRequestContext,
  setSubjectId,
} from "./context";

describe("newRequestId", () => {
  it("matches the pattern the inbound-header check validates against", () => {
    // A mismatch here would make withRequestScope reject its own ids and mint fresh ones
    // on every hop — correlation would break silently, with nothing failing.
    for (let i = 0; i < 50; i++) {
      expect(newRequestId()).toMatch(REQUEST_ID_PATTERN);
    }
  });

  it("is unpredictable and per-call", () => {
    expect(new Set(Array.from({ length: 200 }, newRequestId)).size).toBe(200);
  });
});

describe("runWithRequestContext", () => {
  it("is undefined outside a scope, so the logger simply omits the fields", () => {
    expect(requestContext()).toBeUndefined();
  });

  it("survives an await chain", async () => {
    await runWithRequestContext({ requestId: "a".repeat(16) }, async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(requestContext()?.requestId).toBe("a".repeat(16));
    });
  });

  it("keeps concurrent scopes apart", async () => {
    const seen = await Promise.all(
      ["1", "2", "3"].map((id) =>
        runWithRequestContext({ requestId: id }, async () => {
          await new Promise((resolve) => setTimeout(resolve, 2));
          return requestContext()?.requestId;
        }),
      ),
    );

    expect(seen).toEqual(["1", "2", "3"]);
  });

  it("survives into a timer created inside the scope", async () => {
    /*
     * The property the SSE monitor depends on. Its status poll is a setInterval created
     * while the route handler's scope is still open, and it fires for up to fifteen
     * minutes after the handler returned. AsyncLocalStorage captures the store when the
     * async resource is created, not when it runs, so those ticks stay correlated.
     */
    const observed = await runWithRequestContext(
      { requestId: "detached" },
      () =>
        new Promise<string | undefined>((resolve) => {
          setTimeout(() => resolve(requestContext()?.requestId), 1);
        }),
    );

    expect(observed).toBe("detached");
  });
});

describe("setSubjectId", () => {
  it("attaches identity to a scope entered before it was known", () => {
    // Handlers enter the scope, then open the session. Lines logged in between still
    // share the request id; lines after also carry the subject.
    runWithRequestContext({ requestId: "x".repeat(16) }, () => {
      expect(requestContext()?.subjectId).toBeUndefined();
      setSubjectId("user_123");
      expect(requestContext()?.subjectId).toBe("user_123");
    });
  });

  it("is a no-op outside a scope rather than a throw", () => {
    expect(() => setSubjectId("user_123")).not.toThrow();
  });
});
