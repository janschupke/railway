import { describe, expect, it } from "vitest";
import { LIMITS } from "./constants";
import { spinDownSchema, spinUpSchema } from "./validation";

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

  it("rejects an empty name with a message a user can act on", () => {
    const parsed = spinUpSchema.safeParse({ ...valid, name: "   " });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe("Give the container a name");
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
