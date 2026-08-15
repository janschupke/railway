/**
 * How a failed dashboard read turns into a sentence, and which missing scopes are worth
 * mentioning.
 *
 * Shared by both loaders and by neither's subject. `describe` is the only place the
 * dashboard turns a thrown value into copy, and keeping it beside one of the two reads made
 * the other look like it was borrowing something.
 */

import "server-only";

import { getTranslations } from "next-intl/server";
import { reportError } from "@/lib/report-error";
import type { MessageKey } from "@/lib/messages";

type Translator = Awaited<ReturnType<typeof getTranslations>>;

/**
 * Scopes requested at consent that Railway did not grant.
 *
 * `openid`/`email`/`profile` are omitted deliberately: losing them changes what the
 * header shows, not whether the app works, and naming them here would push the user
 * toward a re-consent that fixes nothing.
 */
const SCOPES_THAT_MATTER = [
  "project:admin",
  "workspace:viewer",
  "offline_access",
] as const;

export function missingScopes(granted: string): string[] {
  const held = new Set(granted.split(/\s+/).filter(Boolean));
  return SCOPES_THAT_MATTER.filter((scope) => !held.has(scope));
}

/**
 * A Railway failure explains itself where it can; anything else falls back to the
 * message for the read that failed. Both come from the catalog, and reportError has
 * already written the upstream text to the log against the id the sentence carries.
 */
export function describe(t: Translator, error: unknown, fallback: MessageKey): string {
  const descriptor = reportError("dashboard", error, fallback);
  return t(descriptor.key as Parameters<Translator>[0], descriptor.values as never);
}
