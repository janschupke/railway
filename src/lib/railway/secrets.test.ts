import { describe, expect, it } from "vitest";
import type { PresetVariable } from "@/lib/presets";
import { resolveVariables } from "./secrets";

/** What the catalog declares for a postgres image. */
const POSTGRES: readonly PresetVariable[] = [
  { name: "POSTGRES_PASSWORD", generate: "password" },
];

/** A preset carrying both kinds of default. */
const MONGO: readonly PresetVariable[] = [
  { name: "MONGO_INITDB_ROOT_USERNAME", value: "root" },
  { name: "MONGO_INITDB_ROOT_PASSWORD", generate: "password" },
];

describe("resolveVariables", () => {
  describe("with no rows on the wire", () => {
    /*
     * The pre-T-487 path. Still reachable by a form posted without JavaScript, so it is
     * a live branch rather than a compatibility shim.
     */
    it("returns nothing for a preset that boots bare", () => {
      // Not an empty object: the caller uses the absence to skip the mutation entirely.
      expect(resolveVariables(undefined)).toEqual({
        variables: undefined,
        generated: false,
      });
      expect(resolveVariables([])).toEqual({ variables: undefined, generated: false });
    });

    it("passes a literal through unchanged", () => {
      expect(
        resolveVariables([{ name: "RABBITMQ_DEFAULT_USER", value: "admin" }]),
      ).toEqual({ variables: { RABBITMQ_DEFAULT_USER: "admin" }, generated: false });
    });

    it("mints a fresh credential per creation", () => {
      const first = resolveVariables(POSTGRES).variables!.POSTGRES_PASSWORD!;
      const second = resolveVariables(POSTGRES).variables!.POSTGRES_PASSWORD!;

      expect(first).not.toBe(second);
      // base64url, so it survives every place Railway might put it verbatim.
      expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(first.length).toBeGreaterThanOrEqual(32);
      expect(resolveVariables(POSTGRES).generated).toBe(true);
    });
  });

  describe("with rows on the wire", () => {
    it("uses the value the user typed, and mints nothing", () => {
      const { variables, generated } = resolveVariables(POSTGRES, [
        { name: "POSTGRES_PASSWORD", value: "hunter2hunter2" },
      ]);
      expect(variables).toEqual({ POSTGRES_PASSWORD: "hunter2hunter2" });
      // The "credentials are on Railway" sentence would be a lie here.
      expect(generated).toBe(false);
    });

    it("mints for a blank row the catalog declares generated", () => {
      const { variables, generated } = resolveVariables(POSTGRES, [
        { name: "POSTGRES_PASSWORD", value: "" },
      ]);
      expect(variables!.POSTGRES_PASSWORD).toMatch(/^[A-Za-z0-9_-]{32,}$/);
      expect(generated).toBe(true);
    });

    it("mints nothing for a blank row the catalog does not own", () => {
      /*
       * The replacement security property, at the unit tier, and the most important
       * assertion in this file.
       *
       * A request can name any variable it likes, but it cannot ask this function to mint
       * one — only a name the catalog declared `generate` for the submitted image can,
       * and only by being left blank. If this ever returns a secret, "generate me a
       * credential" has become a request shape.
       */
      const { variables, generated } = resolveVariables(POSTGRES, [
        { name: "NOT_A_PRESET_KEY", value: "" },
      ]);
      expect(variables).toEqual({ NOT_A_PRESET_KEY: "" });
      expect(generated).toBe(false);
    });

    it("mints nothing for a generated name belonging to a different image", () => {
      // The mintable set is derived from the submitted image's preset, not from the
      // union of everything the catalog generates anywhere.
      const { variables, generated } = resolveVariables(POSTGRES, [
        { name: "MYSQL_ROOT_PASSWORD", value: "" },
      ]);
      expect(variables).toEqual({ MYSQL_ROOT_PASSWORD: "" });
      expect(generated).toBe(false);
    });

    it("sets a blanked literal default empty rather than restoring it", () => {
      // Submitted wins, always. Clearing a row is a deliberate act, and a merge that
      // quietly undid it would be the hidden merge this ticket exists to remove.
      const { variables } = resolveVariables(MONGO, [
        { name: "MONGO_INITDB_ROOT_USERNAME", value: "" },
      ]);
      expect(variables).toEqual({ MONGO_INITDB_ROOT_USERNAME: "" });
    });

    it("does not resurrect a catalog default the user did not send", () => {
      const { variables } = resolveVariables(MONGO, [{ name: "MY_FLAG", value: "on" }]);
      expect(variables).toEqual({ MY_FLAG: "on" });
    });

    it("carries a mixed submission through in one map", () => {
      const { variables, generated } = resolveVariables(MONGO, [
        { name: "MONGO_INITDB_ROOT_USERNAME", value: "root" },
        { name: "MONGO_INITDB_ROOT_PASSWORD", value: "" },
        { name: "MY_FLAG", value: "on" },
      ]);
      expect(Object.keys(variables!)).toEqual([
        "MONGO_INITDB_ROOT_USERNAME",
        "MONGO_INITDB_ROOT_PASSWORD",
        "MY_FLAG",
      ]);
      expect(variables!.MONGO_INITDB_ROOT_PASSWORD).toMatch(/^[A-Za-z0-9_-]{32,}$/);
      expect(generated).toBe(true);
    });

    it("sets user variables on an image the catalog has never heard of", () => {
      const { variables, generated } = resolveVariables(undefined, [
        { name: "GREETING", value: "hello" },
      ]);
      expect(variables).toEqual({ GREETING: "hello" });
      expect(generated).toBe(false);
    });
  });
});
