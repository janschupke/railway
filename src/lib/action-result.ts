import { SessionExpiredError } from "@/lib/auth/refresh";
import { reportError } from "@/lib/report-error";
import type { MessageDescriptor } from "@/lib/messages";

/** Field names a Server Action can attribute an error to. */
export type ActionField = "name" | "image";

export type ActionResult =
  { ok: true; message: string } | { ok: false; error: string; field?: ActionField };

/**
 * Turns any thrown value into a message the person who clicked the button can read.
 *
 * Returns a descriptor rather than a string: every branch names a catalog key, so no
 * raw API text — and nothing derived from the access token — can reach the browser.
 */
export function describeActionError(error: unknown): MessageDescriptor {
  if (error instanceof SessionExpiredError) {
    return { key: "errors.sessionExpired" };
  }
  return reportError("action", error, "errors.generic");
}

export function isField(value: unknown): value is ActionField {
  return value === "name" || value === "image";
}
