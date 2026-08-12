import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_IMAGE, PRESETS, presetFor, repositoryOf } from "./presets";
import { spinUpSchema } from "./validation";

const messages = JSON.parse(
  readFileSync(
    path.join(import.meta.dirname, "..", "..", "messages", "en.json"),
    "utf8",
  ),
) as { presets: { labels: Record<string, string>; groups: Record<string, string> } };

describe("repositoryOf", () => {
  it("strips a tag", () => {
    expect(repositoryOf("redis:7-alpine")).toBe("redis");
  });

  it("strips a digest", () => {
    expect(repositoryOf(`redis@sha256:${"a".repeat(64)}`)).toBe("redis");
    expect(repositoryOf(`redis:7@sha256:${"a".repeat(64)}`)).toBe("redis");
  });

  it("keeps the registry", () => {
    expect(repositoryOf("ghcr.io/owner/app:1.0.0")).toBe("ghcr.io/owner/app");
  });

  it("does not mistake a registry port for a tag", () => {
    // The last colon segment is a tag only when it contains no slash. Getting this
    // wrong turns `localhost:5000/app` into `localhost`.
    expect(repositoryOf("localhost:5000/app")).toBe("localhost:5000/app");
  });
});

describe("presetFor", () => {
  it("matches on the repository, not the exact reference", () => {
    /*
     * `postgres:17` is still postgres and still exits without a password. Pinning the
     * match to the catalog's own tag would hand the user the crash loop the preset
     * exists to prevent.
     */
    expect(presetFor("postgres:17")?.labelKey).toBe("postgres");
    expect(presetFor("postgres")?.labelKey).toBe("postgres");
    expect(presetFor("POSTGRES:16-alpine")?.labelKey).toBe("postgres");
  });

  it("does not claim an unrelated image that happens to be named the same", () => {
    // A different registry is a different image, and this app has no idea what it is.
    expect(presetFor("ghcr.io/owner/postgres:1")).toBeUndefined();
    expect(presetFor("ghcr.io/owner/app:1.0.0")).toBeUndefined();
  });
});

describe("the catalog", () => {
  it("only offers images the server would accept", () => {
    // A list that can produce a value the server rejects is a trap, not a shortcut.
    for (const preset of PRESETS) {
      const parsed = spinUpSchema.safeParse({
        projectId: "p1",
        environmentId: "e1",
        name: "x",
        image: preset.value,
      });
      expect(parsed.success, preset.value).toBe(true);
    }
  });

  it("names every label and group in the catalog of messages", () => {
    // The keys are type-checked against the JSON, but only for the keys that exist;
    // this is what catches a key deleted from the catalog while a preset still uses it.
    for (const preset of PRESETS) {
      expect(messages.presets.labels, preset.value).toHaveProperty(preset.labelKey);
      expect(messages.presets.groups, preset.value).toHaveProperty(preset.groupKey);
    }
  });

  it("gives every database the environment it needs to boot", () => {
    /*
     * The standing constraint on this list: a preset that boots and immediately exits
     * shows a crash loop and reads as a bug in this app rather than in the image. Every
     * official database image exits without a root credential, so every entry filed
     * under `database` must carry one.
     */
    for (const preset of PRESETS.filter((p) => p.groupKey === "database")) {
      const generated = preset.variables?.filter((v) => "generate" in v) ?? [];
      expect(generated.length, preset.value).toBeGreaterThan(0);
    }
  });

  it("defaults to something that stays running", () => {
    expect(presetFor(DEFAULT_IMAGE)).toBeDefined();
    expect(presetFor(DEFAULT_IMAGE)?.variables).toBeUndefined();
  });

  it("lists no image twice", () => {
    const seen = PRESETS.map((p) => p.value);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
