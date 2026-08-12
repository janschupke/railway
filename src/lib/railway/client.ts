import "server-only";

import { env } from "@/env";
import { NETWORK } from "@/lib/constants";
import { log } from "@/lib/logger";
import { RailwayApiError } from "./errors";

/** Configurable so the E2E fixture can stand in for Railway. Defaults to production. */
export const railwayApiUrl = () => env().RAILWAY_API_URL;
export const railwayWsUrl = () => env().RAILWAY_WS_URL;

/**
 * One entry of a GraphQL `errors[]` array.
 *
 * `path` is modelled rather than ignored because it is the only thing that says *which*
 * field Railway refused, and that is what turns "Railway rejected the operation" into a
 * sentence naming the permission that is missing. See scopeForPath in ./errors.
 */
type GraphQLErrorEntry = {
  message: string;
  path?: Array<string | number>;
  extensions?: Record<string, unknown> & { code?: string };
};

type GraphQLResponse<T> = {
  data?: T | null;
  errors?: GraphQLErrorEntry[];
};

/**
 * Railway's authorization refusals, which do not use the codes the spec suggests.
 *
 * Verified against the live API: an unauthorized field comes back as HTTP 200 with
 * `{"message":"Not Authorized","extensions":{"code":"INTERNAL_SERVER_ERROR"}}` — never
 * UNAUTHENTICATED or FORBIDDEN. Matching only on those two codes is what classified
 * every permission problem as a generic operation failure, which then offered a Retry
 * that could not possibly work and withheld the re-authorize that would have.
 */
const AUTH_MESSAGE =
  /\b(not\s+authorized|unauthorized|unauthenticated|forbidden|access denied)\b|\b(invalid|expired|revoked)\s+(access\s+)?token\b/i;

function isAuthEntry(entry: GraphQLErrorEntry): boolean {
  const code = entry.extensions?.code;
  if (code === "UNAUTHENTICATED" || code === "FORBIDDEN") return true;
  // A validation failure can mention "field" wording that trips nothing here; the code
  // is checked first so a genuine schema rejection is never mistaken for a permission.
  if (code === "GRAPHQL_VALIDATION_FAILED") return false;
  return AUTH_MESSAGE.test(entry.message);
}

/** One `errors[]` entry, classified and carried with everything needed to explain it. */
function toApiError(
  entry: GraphQLErrorEntry,
  operationName: string,
  status: number,
): RailwayApiError {
  const code = entry.extensions?.code;
  const auth = isAuthEntry(entry);
  return new RailwayApiError(entry.message || "Railway rejected the operation", {
    kind: auth ? "auth" : "graphql",
    status,
    operation: operationName,
    ...(code ? { code } : {}),
    ...(entry.path ? { path: entry.path } : {}),
  });
}

export type GqlOptions = {
  accessToken: string;
  operationName: string;
  signal?: AbortSignal;
  timeoutMs?: number;
};

function backoffMs(attempt: number, retryAfterSeconds?: number): number {
  if (retryAfterSeconds) return retryAfterSeconds * 1000;
  return NETWORK.RETRY_BASE_MS * NETWORK.RETRY_FACTOR ** (attempt - 1);
}

function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get("retry-after") ?? headers.get("x-ratelimit-reset");
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retries were entirely silent, which meant Railway rate-limiting this app was invisible
 * until the third attempt threw — and by then the record says "rate limited" without
 * saying it had been degrading for a second and a half first.
 *
 * Bounded by construction at MAX_ATTEMPTS - 1 lines per failing call. The successful
 * calls are not logged here at all; see the `debug` line in `execute`'s caller.
 */
function logRetry(
  operation: string,
  attempt: number,
  reason: string,
  backoff: number,
  status?: number,
): void {
  log.warn("railway.request.retry", {
    operation,
    attempt,
    reason,
    backoff_ms: backoff,
    ...(status === undefined ? {} : { status }),
  });
}

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
async function execute<T>(
  query: string,
  variables: Record<string, unknown>,
  options: GqlOptions,
): Promise<{ body: GraphQLResponse<T>; status: number }> {
  const {
    accessToken,
    operationName,
    signal,
    timeoutMs = NETWORK.REQUEST_TIMEOUT_MS,
  } = options;

  const startedAt = Date.now();

  for (let attempt = 1; attempt <= NETWORK.MAX_ATTEMPTS; attempt++) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await fetch(railwayApiUrl(), {
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
      if (attempt === NETWORK.MAX_ATTEMPTS) {
        throw new RailwayApiError("Request to Railway failed", {
          kind: "network",
          operation: operationName,
          cause,
        });
      }
      logRetry(operationName, attempt, "network", backoffMs(attempt));
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
      const retryAfterSeconds = parseRetryAfter(response.headers);
      if (attempt === NETWORK.MAX_ATTEMPTS) {
        throw new RailwayApiError("Rate limited by Railway", {
          kind: "rate_limit",
          status: 429,
          operation: operationName,
          retryAfterSeconds,
        });
      }
      logRetry(
        operationName,
        attempt,
        "rate_limit",
        backoffMs(attempt, retryAfterSeconds),
        429,
      );
      await sleep(backoffMs(attempt, retryAfterSeconds));
      continue;
    }

    if (response.status >= 500) {
      if (attempt === NETWORK.MAX_ATTEMPTS) {
        throw new RailwayApiError(`Railway returned ${response.status}`, {
          kind: "server",
          status: response.status,
          operation: operationName,
        });
      }
      logRetry(operationName, attempt, "server", backoffMs(attempt), response.status);
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

    /*
     * `debug`, not `info`, and the level is the whole decision: this is the only place
     * every Railway call passes through, so latency lives here — but a dashboard render
     * issues several calls and the stream monitor polls every 2.5 seconds, which at
     * `info` would make this line the dominant volume in the system by an order of
     * magnitude. Available when a latency question is being asked, silent otherwise.
     */
    log.debug("railway.request", {
      operation: operationName,
      status: response.status,
      attempt,
      duration_ms: Date.now() - startedAt,
    });

    // The status rides along so a GraphQL-layer refusal keeps the code Railway answered
    // with, rather than being recorded as a flat 200 it may not have been.
    return { body, status: response.status };
  }

  // Unreachable: every path above either returns or throws on the final attempt.
  throw new RailwayApiError("Exhausted retries", {
    kind: "network",
    operation: operationName,
  });
}

/**
 * A GraphQL call that must fully succeed. Any `errors[]` entry is a failure.
 *
 * This is the right default for mutations and for single-purpose reads: a partial
 * mutation result is not a success, and letting one through would surface later as a
 * TypeError on a null field rather than as the failure it is.
 */
export async function gql<T>(
  query: string,
  variables: Record<string, unknown>,
  options: GqlOptions,
): Promise<T> {
  const { body, status } = await execute<T>(query, variables, options);

  const [firstError] = body.errors ?? [];
  if (firstError) {
    // An auth entry outranks the rest: if one field was refused for permissions, that
    // is the actionable cause even when a later entry merely reports the knock-on null.
    const entry = body.errors?.find(isAuthEntry) ?? firstError;
    throw toApiError(entry, options.operationName, status);
  }

  if (!body.data) {
    throw new RailwayApiError("Railway returned an empty response", {
      kind: "graphql",
      status,
      operation: options.operationName,
    });
  }

  return body.data;
}

/**
 * A GraphQL call whose partial result is still worth having.
 *
 * GraphQL nulls the field that failed and reports it alongside whatever else resolved,
 * so a document touching several independent things has a usable answer even when one
 * of them is refused. Throwing on the presence of `errors[]` discarded that: a project
 * list that arrived intact was dropped because a *different* field on the same document
 * was not permitted, and the dashboard showed nothing at all.
 *
 * Transport, rate-limit and 5xx failures still throw — there is no partial result there.
 */
export async function gqlPartial<T>(
  query: string,
  variables: Record<string, unknown>,
  options: GqlOptions,
): Promise<{ data: T | null; errors: RailwayApiError[] }> {
  const { body, status } = await execute<T>(query, variables, options);
  return {
    data: body.data ?? null,
    errors: (body.errors ?? []).map((entry) =>
      toApiError(entry, options.operationName, status),
    ),
  };
}
