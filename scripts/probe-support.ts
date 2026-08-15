/**
 * What every probe needs before it can ask Railway anything.
 *
 * The probes are deliberately verbose files — each one's docblock records what a live
 * session actually answered, which is the whole reason `architecture.md` says not to
 * re-run them. That prose is worth keeping. The forty lines underneath it were not: seven
 * scripts declared the same four ANSI helpers, six resolved `RC_SESSION` through the same
 * two guards and the same `openSession` call, and six posted GraphQL with the same fetch
 * and the same non-JSON fallback.
 *
 * Not shared with `src/lib/railway/client.ts`, and that is a decision rather than an
 * oversight: the client retries, times out, classifies errors and logs structured records,
 * every one of which would get in the way here. A probe wants the unvarnished answer,
 * including the failures the app is built to survive.
 */

import { openSession } from "../src/lib/auth/session.ts";
import { RAILWAY_DEFAULTS } from "../src/env.ts";

export const ENDPOINT = process.env.RAILWAY_API_URL ?? RAILWAY_DEFAULTS.API_URL;

export const ok = (s: string) => `\x1b[32m✓\x1b[0m ${s}`;
export const bad = (s: string) => `\x1b[31m✗\x1b[0m ${s}`;
export const warn = (s: string) => `\x1b[33m!\x1b[0m ${s}`;
export const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

/**
 * What a GraphQL endpoint answers, before anyone decides whether it is an answer.
 *
 * `extensions.code` is optional because Railway does not always send one, and a probe that
 * assumed it prints `undefined` where the interesting part of a refusal should be. `path`
 * is what says *which* field was refused when only part of a document was — the shape the
 * app's degrading reads are built on, so a probe that drops it cannot see them working.
 */
export type GraphQLBody<T = unknown> = {
  data?: T | null;
  errors?: {
    message: string;
    path?: (string | number)[];
    extensions?: { code?: string };
  }[];
};

/**
 * Opens the session behind `RC_SESSION`, or explains what is missing and stops.
 *
 * Exits rather than throwing, because there is no caller that could do anything useful
 * with the failure — a probe with no credential has nothing to probe. `usage` is the one
 * line that differed between the copies: it is the invocation to print back, and it
 * carries each script's own arguments.
 */
export async function openProbeSession(usage: string) {
  const cookie = process.env.RC_SESSION;
  const secret = process.env.SESSION_SECRET;

  if (!secret) {
    console.error(bad("SESSION_SECRET is not set."));
    console.error("  Run through the package script, which loads .env:");
    console.error(`    ${usage}\n`);
    process.exit(1);
  }
  if (!cookie) {
    console.error(bad("RC_SESSION is not set."));
    console.error("  Sign in, then copy the `rc_session` cookie value:");
    console.error("    DevTools → Application → Cookies → rc_session\n");
    console.error(`    ${usage}\n`);
    process.exit(1);
  }

  const session = await openSession(cookie, secret);
  if (!session) {
    console.error(
      bad("Could not open that session — wrong SESSION_SECRET, or the cookie expired."),
    );
    process.exit(1);
  }
  return session;
}

/**
 * One GraphQL request, with no retry, no timeout and no interpretation.
 *
 * A non-JSON body comes back as an `errors` entry rather than throwing, because that is
 * itself an observation worth printing: Railway answering HTML to an authenticated POST is
 * a thing these scripts exist to catch.
 */
export async function postGraphQL<T = Record<string, unknown>>(
  token: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<GraphQLBody<T>> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(variables ? { query, variables } : { query }),
  });
  try {
    return (await response.json()) as GraphQLBody<T>;
  } catch {
    return { errors: [{ message: `non-JSON response (HTTP ${response.status})` }] };
  }
}
