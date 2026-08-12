import "server-only";

import { RailwayApiError } from "./errors";

export const RAILWAY_GRAPHQL_HTTP = "https://backboard.railway.com/graphql/v2";
export const RAILWAY_GRAPHQL_WS = "wss://backboard.railway.com/graphql/v2";

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;

type GraphQLResponse<T> = {
  data?: T;
  errors?: Array<{
    message: string;
    path?: Array<string | number>;
    extensions?: { code?: string };
  }>;
};

export type GqlOptions = {
  accessToken: string;
  operationName: string;
  signal?: AbortSignal;
  timeoutMs?: number;
};

function backoffMs(attempt: number, retryAfterSeconds?: number): number {
  if (retryAfterSeconds) return retryAfterSeconds * 1000;
  // 400ms, 1200ms — deliberately short; a human is watching a button spinner.
  return 400 * 3 ** (attempt - 1);
}

function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get("retry-after") ?? headers.get("x-ratelimit-reset");
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Single choke point for every Railway GraphQL call.
 *
 * Handles the three things that make this API awkward to use naively:
 *  - errors arrive as HTTP 200 with an `errors[]` body, so `res.ok` proves nothing;
 *  - rate limits are per-plan and low (Hobby: 10 rps / 1000 per hour) and are
 *    signalled through `Retry-After` / `X-RateLimit-*`, which we honour rather than
 *    hammering;
 *  - a 401 means the user's authorization is gone, which is a re-consent prompt and
 *    not a retry.
 */
export async function gql<T>(
  query: string,
  variables: Record<string, unknown>,
  options: GqlOptions,
): Promise<T> {
  const { accessToken, operationName, signal, timeoutMs = DEFAULT_TIMEOUT_MS } =
    options;

  let lastRateLimitRetryAfter: number | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await fetch(RAILWAY_GRAPHQL_HTTP, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ query, variables }),
        signal: composed,
        cache: "no-store",
      });
    } catch (cause) {
      // Caller-initiated abort is not a failure worth retrying.
      if (signal?.aborted) throw cause;
      if (attempt === MAX_ATTEMPTS) {
        throw new RailwayApiError("Request to Railway failed", {
          kind: "network",
          operation: operationName,
          cause,
        });
      }
      await sleep(backoffMs(attempt));
      continue;
    }

    if (response.status === 401 || response.status === 403) {
      throw new RailwayApiError("Railway rejected the credentials", {
        kind: "auth",
        status: response.status,
        operation: operationName,
      });
    }

    if (response.status === 429) {
      lastRateLimitRetryAfter = parseRetryAfter(response.headers);
      if (attempt === MAX_ATTEMPTS) {
        throw new RailwayApiError("Rate limited by Railway", {
          kind: "rate_limit",
          status: 429,
          operation: operationName,
          retryAfterSeconds: lastRateLimitRetryAfter,
        });
      }
      await sleep(backoffMs(attempt, lastRateLimitRetryAfter));
      continue;
    }

    if (response.status >= 500) {
      if (attempt === MAX_ATTEMPTS) {
        throw new RailwayApiError(`Railway returned ${response.status}`, {
          kind: "server",
          status: response.status,
          operation: operationName,
        });
      }
      await sleep(backoffMs(attempt));
      continue;
    }

    let body: GraphQLResponse<T>;
    try {
      body = (await response.json()) as GraphQLResponse<T>;
    } catch (cause) {
      throw new RailwayApiError("Railway returned a non-JSON response", {
        kind: "network",
        status: response.status,
        operation: operationName,
        cause,
      });
    }

    if (body.errors?.length) {
      const first = body.errors[0];
      const code = first.extensions?.code;
      // GraphQL-layer auth failures also surface as 200 + errors[].
      const kind =
        code === "UNAUTHENTICATED" || code === "FORBIDDEN" ? "auth" : "graphql";
      throw new RailwayApiError(first.message || "Railway rejected the operation", {
        kind,
        status: response.status,
        operation: operationName,
      });
    }

    if (!body.data) {
      throw new RailwayApiError("Railway returned an empty response", {
        kind: "graphql",
        status: response.status,
        operation: operationName,
      });
    }

    return body.data;
  }

  // Unreachable: every path above either returns or throws on the final attempt.
  throw new RailwayApiError("Exhausted retries", {
    kind: "network",
    operation: operationName,
  });
}
