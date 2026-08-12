import "server-only";

import { randomBytes } from "node:crypto";
import type { PresetVariable } from "@/lib/presets";

/**
 * Bytes of entropy per generated credential. 24 bytes is 32 base64url characters, which
 * is well past anything a database password needs and short enough to select by hand.
 */
const PASSWORD_BYTES = 24;

/**
 * Resolves a preset's declared variables into the values a service is created with.
 *
 * Separate from the catalog on purpose: `presets.ts` is imported by the client for its
 * labels, and `node:crypto` must not follow it there. The catalog stays declarative and
 * this is the only thing that mints a secret.
 *
 * Generated values are returned and never retained. They are not logged, not stored, and
 * not sent to the browser — the user reads them on Railway's own service → Variables
 * page, which is where every other Railway secret lives. This app has no database and is
 * not going to become a password manager.
 */
export function resolveVariables(
  variables: readonly PresetVariable[] | undefined,
): Record<string, string> | undefined {
  if (!variables?.length) return undefined;

  const resolved: Record<string, string> = {};
  for (const variable of variables) {
    resolved[variable.name] =
      "generate" in variable
        ? randomBytes(PASSWORD_BYTES).toString("base64url")
        : variable.value;
  }
  return resolved;
}
