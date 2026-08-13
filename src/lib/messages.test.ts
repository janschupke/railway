import { describe, expect, it } from "vitest";
import catalog from "../../messages/en.json";
import { MESSAGE_KEYS } from "./messages";

/**
 * The two-edit rule, checked.
 *
 * i18n.md: a key reachable from non-rendering code needs a MessageKey member AND a
 * catalog entry. Only one half was ever mechanical — the union makes a typo a compile
 * error — so the other half could be forgotten and the symptom would be next-intl
 * echoing the key back to the user as if it were a sentence, which is exactly what
 * happened with zod's messages elsewhere in this series.
 */

/** Follows a dotted key through the catalog, returning the leaf string if there is one. */
function resolve(key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        typeof node === "object" && node !== null
          ? (node as Record<string, unknown>)[part]
          : undefined,
      catalog,
    );
}

/** Every dotted path under `errors` that ends in a string. */
function leaves(node: unknown, prefix: string): string[] {
  if (typeof node === "string") return [prefix];
  if (typeof node !== "object" || node === null) return [];
  return Object.entries(node).flatMap(([key, value]) =>
    leaves(value, prefix ? `${prefix}.${key}` : key),
  );
}

describe("MessageKey", () => {
  it("names only keys the catalog actually holds", () => {
    for (const key of MESSAGE_KEYS) {
      expect(typeof resolve(key), `${key} is missing from messages/en.json`).toBe(
        "string",
      );
    }
  });

  it("covers every error the catalog offers", () => {
    /*
     * The other direction, which is the one that catches a key added to the catalog for
     * code that then cannot name it. An error entry no descriptor can reach is either
     * dead copy or a missing member, and both are worth a diff.
     */
    const catalogErrors = leaves(catalog.errors, "errors").sort();
    expect(catalogErrors).toEqual([...MESSAGE_KEYS].sort());
  });
});
