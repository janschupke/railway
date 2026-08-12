import { HttpResponse, graphql, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { gql, railwayApiUrl } from "./client";
import { RailwayApiError } from "./errors";

const ENDPOINT = railwayApiUrl();
const api = graphql.link(ENDPOINT);
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const QUERY = /* GraphQL */ `
  query Ping {
    me {
      id
    }
  }
`;

const call = () =>
  gql<{ me: { id: string } }>(
    QUERY,
    {},
    { accessToken: "t0ken", operationName: "Ping" },
  );

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

  it("never leaks the token into a client-facing error", async () => {
    server.use(http.post(ENDPOINT, () => new HttpResponse(null, { status: 401 })));

    const error = (await call().catch((e: unknown) => e)) as RailwayApiError;
    expect(JSON.stringify(error.describe())).not.toContain("t0ken");
  });
});
