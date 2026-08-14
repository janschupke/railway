import { SessionExpiredError } from "@/lib/auth/refresh";
import { log } from "@/lib/logger";
import { reportError } from "@/lib/report-error";
import type { MessageDescriptor } from "@/lib/messages";

/**
 * Field names a Server Action can attribute an error to.
 *
 * Not every field that can fail is here, and the gap is deliberate. `region` and
 * `restartPolicy` are closed-set selects whose options this app rendered, so a person cannot
 * produce an invalid one at all — their only reachable failure is a stale page or a
 * hand-crafted request, and both are answered by a sentence about the page rather than about
 * a control. Adding them would put "reload the page" under a dropdown the user just used
 * correctly. See action-result.test.ts, which asserts they are absent.
 */
export type ActionField =
  | "name"
  | "image"
  | "port"
  | "replicas"
  | "cpu"
  | "memory"
  | "restartRetries"
  | "startCommand"
  | "variableKey"
  | "variableValue"
  | "projectName"
  | "environmentName";

/**
 * What the client should select once an action has created it.
 *
 * Ids only, and that bound is the point: an action returns no upstream text on any path,
 * and these two values are about to be written into a query string anyway — selection
 * lives in the URL and nowhere else (see `.ai/rules/architecture.md`). Without this the
 * only honest thing a create dialog could do is refresh and leave the user to find what
 * they just made in a picker of things that all look alike.
 *
 * `environmentId` is optional because only the project path can be sure of one: Railway
 * returns the new project's default environment in the same response, but a caller that
 * ever creates a project without one should drop the parameter rather than invent it.
 */
export type ActionSelection = { projectId: string; environmentId?: string };

export type ActionResult =
  | { ok: true; message: string; select?: ActionSelection }
  | {
      ok: false;
      error: string;
      field?: ActionField;
      /**
       * Which row of a repeated field the error belongs to, zero-based over the rows that
       * were actually submitted.
       *
       * Not the same as the rows on screen: a blank row carries no `name` attribute and
       * so never reaches FormData at all. The form maps it back to a row id — see
       * spin-up-form.tsx.
       *
       * Absent for the single-instance fields, and absent for a rule about the whole list
       * rather than one row of it, where there is no row to point at. A field error with
       * no index has to reach the user as a toast.
       */
      index?: number;
    };

/**
 * Turns any thrown value into a message the person who clicked the button can read.
 *
 * Returns a descriptor rather than a string: every branch names a catalog key, so no
 * raw API text — and nothing derived from the access token — can reach the browser.
 */
export function describeActionError(error: unknown): MessageDescriptor {
  if (error instanceof SessionExpiredError) {
    /*
     * This branch short-circuits before reportError, so an action that failed on an
     * expired session used to produce no log line at all. `info`, not `warn`: an expired
     * session is the ordinary end of a session's life, not an anomaly. The error is
     * passed so the record says which of the two SessionExpiredError paths this was.
     */
    log.info("action.session_expired", { error });
    return { key: "errors.sessionExpired" };
  }
  return reportError("action", error, "errors.generic");
}

/*
 * A set rather than a chain of ===: the two variable fields made the expression long
 * enough that the next addition would have been the one to get the || precedence wrong.
 */
const FIELDS: ReadonlySet<string> = new Set([
  "name",
  "image",
  "port",
  "replicas",
  "cpu",
  "memory",
  "restartRetries",
  "startCommand",
  "variableKey",
  "variableValue",
  "projectName",
  "environmentName",
]);

export function isField(value: unknown): value is ActionField {
  /*
   * The string guard is load-bearing rather than defensive. zod's path for a repeated
   * field is ["variableKey", 3], so a numeric array index now genuinely arrives at this
   * function — and `FIELDS.has` alone would be fine, but the guard is what makes that
   * readable to the next person.
   */
  return typeof value === "string" && FIELDS.has(value);
}
