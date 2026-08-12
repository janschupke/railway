import { describe, expect, it } from "vitest";
import { resolveVariables } from "./secrets";

describe("resolveVariables", () => {
  it("returns nothing for a preset that boots bare", () => {
    // Not an empty object: the caller uses the absence to skip the mutation entirely.
    expect(resolveVariables(undefined)).toBeUndefined();
    expect(resolveVariables([])).toBeUndefined();
  });

  it("passes a literal through unchanged", () => {
    expect(
      resolveVariables([{ name: "RABBITMQ_DEFAULT_USER", value: "admin" }]),
    ).toEqual({ RABBITMQ_DEFAULT_USER: "admin" });
  });

  it("mints a fresh credential per creation", () => {
    const spec = [{ name: "POSTGRES_PASSWORD", generate: "password" }] as const;
    const first = resolveVariables(spec)!.POSTGRES_PASSWORD!;
    const second = resolveVariables(spec)!.POSTGRES_PASSWORD!;

    expect(first).not.toBe(second);
    // base64url, so it survives every place Railway might put it verbatim.
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(first.length).toBeGreaterThanOrEqual(32);
  });
});
