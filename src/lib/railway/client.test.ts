import { HttpResponse, graphql, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { NETWORK } from "@/lib/constants";
import { logRecords } from "@/test/log-capture";
import { gql, railwayApiUrl } from "./client";
import { RailwayApiError } from "./errors";
import type { TypedDocument } from "./typed-document";

const ENDPOINT = railwayApiUrl();
const api = graphql.link(ENDPOINT);
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/*
 * Annotated the way operations.ts annotates the real documents, rather than passing a type
 * argument at the call site — which is no longer possible, and is the defect T-476 closed.
 * Not generated: this document is a transport fixture and does not go to Railway.
 */
const QUERY: TypedDocument<
  { me: { id: string } },
  Record<string, never>
> = /* GraphQL */ `
  query Ping {
    me {
      id
    }
  }
`;

/*
 * No `operationName`: the client reads it off the document now, so QUERY being named
 * `Ping` is what makes the log records below say `Ping`. That is the property this file
 * asserts rather than a value it supplies.
 */
const call = () => gql(QUERY, {}, { accessToken: "t0ken" });

describe("gql", () => {
  it("returns data and sends a bearer token", async () => {
    let seenAuth: string | null = null;
    server.use(
      api.query("Ping", ({ request }) => {
        seenAuth = request.headers.get("authorization");
        return HttpResponse.json({ data: { me: { id: "user_1" } } });
      }),
    );

    await expect(call()).resolves.toEqual({ me: { id: "user_1" } });
    expect(seenAuth).toBe("Bearer t0ken");
  });

  it("treats HTTP 200 with an errors[] payload as a failure", async () => {
    // The trap in this API: res.ok is true and the body still carries an error.
    server.use(
      api.query("Ping", () =>
        HttpResponse.json({ errors: [{ message: "Service not found" }] }),
      ),
    );

    const error = await call().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RailwayApiError);
    expect((error as RailwayApiError).kind).toBe("graphql");
    expect((error as RailwayApiError).message).toBe("Service not found");
  });

  it("reads Railway's own refusal wording as an auth failure", async () => {
    /*
     * Verified against the live API: an unauthorized field comes back as HTTP 200 with
     * `Not Authorized` under INTERNAL_SERVER_ERROR — never UNAUTHENTICATED or FORBIDDEN.
     * Matching only the spec codes classified every permission problem as a generic
     * operation failure, which is what put "Railway rejected the operation" and a
     * useless Retry on screen instead of the re-authorize that would have fixed it.
     */
    server.use(
      api.query("Ping", () =>
        HttpResponse.json({
          data: null,
          errors: [
            {
              message: "Not Authorized",
              path: ["me", "workspaces"],
              extensions: { code: "INTERNAL_SERVER_ERROR" },
            },
          ],
        }),
      ),
    );

    const error = (await call().catch((e: unknown) => e)) as RailwayApiError;
    expect(error.kind).toBe("auth");
    // The path is the only thing that says which permission was missing.
    expect(error.missingScope).toBe("workspace:viewer");
    expect(error.describe().key).toBe("errors.api.missingScope");
  });

  it("still calls a validation failure a schema rejection, not a permission problem", async () => {
    server.use(
      api.query("Ping", () =>
        HttpResponse.json({
          errors: [
            {
              message: 'Cannot query field "nope" on type "User".',
              extensions: { code: "GRAPHQL_VALIDATION_FAILED" },
            },
          ],
        }),
      ),
    );

    const error = (await call().catch((e: unknown) => e)) as RailwayApiError;
    expect(error.kind).toBe("graphql");
    expect(error.isSchemaRejection()).toBe(true);
  });

  it("classifies a GraphQL-layer UNAUTHENTICATED code as an auth failure", async () => {
    server.use(
      api.query("Ping", () =>
        HttpResponse.json({
          errors: [
            { message: "Not authorized", extensions: { code: "UNAUTHENTICATED" } },
          ],
        }),
      ),
    );

    const error = (await call().catch((e: unknown) => e)) as RailwayApiError;
    expect(error.kind).toBe("auth");
  });

  it("does not retry a 401 — a revoked authorization needs re-consent, not patience", async () => {
    let attempts = 0;
    server.use(
      http.post(ENDPOINT, () => {
        attempts += 1;
        return new HttpResponse(null, { status: 401 });
      }),
    );

    const error = (await call().catch((e: unknown) => e)) as RailwayApiError;
    expect(error.kind).toBe("auth");
    expect(attempts).toBe(1);
  });

  it("retries a 429 and succeeds", async () => {
    let attempts = 0;
    server.use(
      http.post(ENDPOINT, () => {
        attempts += 1;
        if (attempts === 1) return new HttpResponse(null, { status: 429 });
        return HttpResponse.json({ data: { me: { id: "user_1" } } });
      }),
    );

    await expect(call()).resolves.toEqual({ me: { id: "user_1" } });
    expect(attempts).toBe(2);
  });

  it("gives up after exhausting retries on 429", async () => {
    let attempts = 0;
    server.use(
      http.post(ENDPOINT, () => {
        attempts += 1;
        return new HttpResponse(null, { status: 429 });
      }),
    );

    const error = (await call().catch((e: unknown) => e)) as RailwayApiError;
    expect(error.kind).toBe("rate_limit");
    expect(attempts).toBe(3);
  }, 10_000);

  it("retries 5xx and surfaces a server error when it persists", async () => {
    server.use(http.post(ENDPOINT, () => new HttpResponse(null, { status: 502 })));

    const error = (await call().catch((e: unknown) => e)) as RailwayApiError;
    expect(error.kind).toBe("server");
    expect(error.status).toBe(502);
  }, 10_000);

  it("abandons a retry backoff when the caller aborts, rather than waiting it out", async () => {
    /*
     * The backoff was the one place a cancelled call still cost real time. An abort
     * during the `fetch` was always honoured; an abort during the wait *between* attempts
     * was not, so a caller that had already hung up held a timer for the full
     * RETRY_BASE_MS before the next attempt failed on the same signal it was already
     * carrying. The call rejects either way — the elapsed time is what changed, which is
     * why it is the assertion.
     */
    const controller = new AbortController();
    let attempts = 0;
    server.use(
      http.post(ENDPOINT, () => {
        attempts += 1;
        /*
         * Fires once this response has been handed back. `execute` does not read a 5xx
         * body, so the next thing it does is log the retry and wait — the abort lands in
         * the backoff, which is the path under test.
         */
        setTimeout(() => controller.abort(), 0);
        return new HttpResponse(null, { status: 502 });
      }),
    );

    const startedAt = Date.now();
    const error = await gql(
      QUERY,
      {},
      { accessToken: "t0ken", signal: controller.signal },
    ).catch((e: unknown) => e);
    const elapsed = Date.now() - startedAt;

    // Proves the first attempt completed and the backoff was entered, rather than the
    // abort having simply raced the fetch.
    expect(logRecords()).toContainEqual(
      expect.objectContaining({ msg: "railway.request.retry", reason: "server" }),
    );
    expect(elapsed).toBeLessThan(NETWORK.RETRY_BASE_MS);
    expect(attempts).toBe(1);
    /*
     * The caller's own reason comes back, not a RailwayApiError. An abort is a decision
     * this app made, not a failure Railway needs classifying, logging or explaining — and
     * the watch route's `if (signal.aborted) return` depends on not being handed one.
     */
    expect(error).toBe(controller.signal.reason);
  });

  it("never leaks the token into a client-facing error", async () => {
    server.use(http.post(ENDPOINT, () => new HttpResponse(null, { status: 401 })));

    const error = (await call().catch((e: unknown) => e)) as RailwayApiError;
    expect(JSON.stringify(error.describe())).not.toContain("t0ken");
  });
});
