import { describe, expect, it } from "vitest";
import { LIMITS } from "./constants";
import { VALIDATION_KEYS, spinDownSchema, spinUpSchema } from "./validation";

const valid = {
  projectId: "p1",
  environmentId: "e1",
  name: "cache",
  image: "redis:7-alpine",
};

describe("spinUpSchema", () => {
  it("accepts a plain tagged image", () => {
    expect(spinUpSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    ["registry-qualified", "ghcr.io/owner/app:1.2.3"],
    ["untagged", "nginx"],
    ["namespaced", "traefik/whoami"],
    ["digest-pinned", `alpine@sha256:${"a".repeat(64)}`],
  ])("accepts a %s reference", (_label, image) => {
    expect(spinUpSchema.safeParse({ ...valid, image }).success).toBe(true);
  });

  it.each([
    ["a shell metacharacter", "redis; rm -rf /"],
    ["a space", "redis 7"],
    ["a leading separator", "/redis"],
    ["backticks", "redis`whoami`"],
  ])("rejects %s", (_label, image) => {
    expect(spinUpSchema.safeParse({ ...valid, image }).success).toBe(false);
  });

  it("trims surrounding whitespace rather than rejecting it", () => {
    const parsed = spinUpSchema.safeParse({ ...valid, name: "  cache  " });
    expect(parsed.success && parsed.data.name).toBe("cache");
  });

  it("rejects an empty name, naming a catalog key rather than a sentence", () => {
    // Schemas carry message ids; the Server Action resolves them against the catalog.
    const parsed = spinUpSchema.safeParse({ ...valid, name: "   " });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe("validation.nameRequired");
  });

  it("gives every rule a message id, so none falls back to zod's own English", () => {
    /*
     * Four rules used to carry no message at all — a >255-char image reference
     * rendered zod's built-in text, which no translation could ever reach.
     */
    const cases = [
      { ...valid, projectId: "" },
      { ...valid, environmentId: "" },
      { ...valid, name: "" },
      { ...valid, name: "x".repeat(LIMITS.CONTAINER_NAME_MAX + 1) },
      { ...valid, image: "" },
      { ...valid, image: `${"x".repeat(LIMITS.IMAGE_REF_MAX + 1)}` },
      { ...valid, image: "NOT A VALID IMAGE" },
    ];

    for (const input of cases) {
      const parsed = spinUpSchema.safeParse(input);
      expect(parsed.success).toBe(false);
      for (const issue of parsed.error?.issues ?? []) {
        expect(issue.message, JSON.stringify(input).slice(0, 60)).toMatch(
          /^validation\./,
        );
      }
    }
  });

  it("bounds the name length", () => {
    const name = "x".repeat(LIMITS.CONTAINER_NAME_MAX + 1);
    expect(spinUpSchema.safeParse({ ...valid, name }).success).toBe(false);
  });

  it("attributes the failure to the field that caused it", () => {
    const parsed = spinUpSchema.safeParse({ ...valid, image: "not valid" });
    expect(parsed.error?.issues[0]?.path[0]).toBe("image");
  });
});

describe("spinDownSchema", () => {
  it("requires all three references", () => {
    expect(
      spinDownSchema.safeParse({
        projectId: "p1",
        environmentId: "e1",
        serviceId: "s1",
      }).success,
    ).toBe(true);
    expect(
      spinDownSchema.safeParse({ projectId: "p1", environmentId: "e1" }).success,
    ).toBe(false);
    expect(
      spinDownSchema.safeParse({ projectId: "", environmentId: "e1", serviceId: "s1" })
        .success,
    ).toBe(false);
  });
});

describe("Railway identifiers from a form", () => {
  /*
   * The route handlers already hold the same class of value to RAILWAY_ID_PATTERN
   * before doing anything expensive. These fields were `.min(1)` only, so a reference
   * carrying path separators — or ten megabytes of it — reached a full project query
   * against Railway before anything looked at the shape.
   */
  const base = { projectId: "p1", environmentId: "e1", serviceId: "s1" };

  it.each([
    ["a path separator", "proj/../admin"],
    ["a dot segment", "proj.admin"],
    ["something unbounded", "x".repeat(65)],
    ["a space", "proj 1"],
  ])("refuses %s", (_label, value) => {
    expect(spinDownSchema.safeParse({ ...base, serviceId: value }).success).toBe(false);
    expect(
      spinUpSchema.safeParse({
        ...base,
        projectId: value,
        name: "cache",
        image: "redis:7",
      }).success,
    ).toBe(false);
  });

  it("names a key the catalog holds, not zod's own English", () => {
    const parsed = spinDownSchema.safeParse({ ...base, serviceId: "proj/../admin" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(VALIDATION_KEYS.has(parsed.error.issues[0]!.message)).toBe(true);
  });

  it("still accepts what Railway actually issues", () => {
    expect(
      spinDownSchema.safeParse({
        ...base,
        serviceId: "8f3c9d2e-4b1a-4c7d-9e2f-1a2b3c4d5e6f",
      }).success,
    ).toBe(true);
  });
});

describe("VALIDATION_KEYS", () => {
  it("covers every message the schemas can produce", () => {
    /*
     * The action treats `issue.message` as a catalog key, which is only safe while
     * every rule carries one. A rule added without a message makes zod supply its own
     * English, and next-intl echoes an unknown key back verbatim — which is how
     * "Invalid input: expected string, received null" reached a toast.
     */
    const messages = new Set<string>();
    const collect = (result: { success: boolean; error?: { issues: unknown[] } }) => {
      if (result.success) return;
      for (const issue of (result.error?.issues ?? []) as Array<{ message: string }>) {
        messages.add(issue.message);
      }
    };

    /*
     * Every field a string, because that is what the action guarantees — it coerces
     * FormData through String(… ?? "") precisely so the type check cannot fire ahead
     * of the rule carrying the key. Passing a non-string here would assert against a
     * shape production can no longer produce.
     */
    collect(spinUpSchema.safeParse({ ...spinUp(), projectId: "" }));
    collect(spinUpSchema.safeParse({ ...spinUp(), environmentId: "" }));
    collect(spinUpSchema.safeParse({ ...spinUp(), projectId: "p/1" }));
    collect(spinUpSchema.safeParse({ ...spinUp(), name: "" }));
    collect(spinUpSchema.safeParse({ ...spinUp(), name: "x".repeat(500) }));
    collect(spinUpSchema.safeParse({ ...spinUp(), image: "" }));
    collect(spinUpSchema.safeParse({ ...spinUp(), image: "x".repeat(500) }));
    collect(spinUpSchema.safeParse({ ...spinUp(), image: "NOT AN IMAGE!!" }));
    collect(spinDownSchema.safeParse({ ...spinDown(), serviceId: "" }));
    collect(spinDownSchema.safeParse({ ...spinDown(), serviceId: "s/1" }));

    expect(messages.size).toBeGreaterThan(0);
    for (const message of messages) expect(VALIDATION_KEYS.has(message)).toBe(true);
  });

  const spinUp = () => ({
    projectId: "p1",
    environmentId: "e1",
    name: "cache",
    image: "redis:7",
  });
  const spinDown = () => ({ projectId: "p1", environmentId: "e1", serviceId: "s1" });
});
