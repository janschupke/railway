import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LIMITS } from "./constants";
import {
  DEFAULT_IMAGE,
  PRESETS,
  httpPortFor,
  presetFor,
  presetVariableDefaults,
  presetVolumeFor,
  repositoryOf,
} from "./presets";
import {
  RESERVED_VARIABLE_PREFIX,
  VARIABLE_NAME_PATTERN,
  spinUpSchema,
} from "./validation";

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
        idempotencyKey: "0123456789abcdef0123456789abcdef",
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

  it("declares only variables its own form would accept", () => {
    /*
     * The drift this guards is specific and would be invisible until someone hit it: a
     * preset's variables are seeded into the editor as rows, and those rows are submitted
     * back through spinUpSchema. A catalog entry the schema refuses is one the form can
     * display and then never accept — a container nobody can create, reported as a
     * validation error against a name the user never typed.
     *
     * The reserved-prefix rule is the live hazard here, since RAILWAY_ is exactly the
     * kind of name an image might plausibly document.
     */
    for (const preset of PRESETS) {
      const variables = preset.variables ?? [];
      expect(variables.length, preset.value).toBeLessThanOrEqual(LIMITS.VARIABLES_MAX);
      for (const variable of variables) {
        expect(variable.name, preset.value).toMatch(VARIABLE_NAME_PATTERN);
        expect(variable.name.length, preset.value).toBeLessThanOrEqual(
          LIMITS.VARIABLE_NAME_MAX,
        );
        expect(
          variable.name.toUpperCase().startsWith(RESERVED_VARIABLE_PREFIX),
          preset.value,
        ).toBe(false);
      }
    }
  });
});

describe("presetVariableDefaults", () => {
  it("gives a generated credential a blank value, not a placeholder one", () => {
    /*
     * The value does not exist until the server mints it, and anything with content here
     * would be a credential the browser holds. Blank is the whole representation; the
     * `generated` flag is what lets the editor say why it is blank.
     */
    expect(presetVariableDefaults("postgres:17")).toEqual([
      { name: "POSTGRES_PASSWORD", value: "", generated: true },
      // Not a credential, and it is here because the volume is: see the note in the catalog
      // on why mounting at the image's own default PGDATA is a boot failure.
      { name: "PGDATA", value: "/var/lib/postgresql/data/pgdata", generated: false },
    ]);
  });

  it("keeps a literal default readable, in catalog order", () => {
    expect(presetVariableDefaults("mongo:7")).toEqual([
      { name: "MONGO_INITDB_ROOT_USERNAME", value: "root", generated: false },
      { name: "MONGO_INITDB_ROOT_PASSWORD", value: "", generated: true },
    ]);
  });

  it("seeds nothing for an image that boots bare, or one it does not know", () => {
    expect(presetVariableDefaults("nginx:alpine")).toEqual([]);
    expect(presetVariableDefaults("ghcr.io/owner/app:1.0.0")).toEqual([]);
  });

  it("matches on the repository, like presetFor", () => {
    expect(presetVariableDefaults("postgres")).toHaveLength(2);
  });
});

describe("presetVolumeFor", () => {
  /*
   * The list is asserted rather than derived from PRESETS, which is the point: a preset that
   * writes state and carries no volume is the defect T-491 fixed, and deriving the
   * expectation from the catalog would make this test agree with whatever the catalog says
   * next. Adding a stateful image means adding it here too, deliberately.
   */
  it("covers every image that keeps state, and nothing else", () => {
    const withVolume = PRESETS.filter((preset) => preset.volume).map((p) => p.value);
    expect(withVolume.toSorted()).toEqual([
      "mariadb:11",
      "mongo:7",
      "mysql:8",
      "postgres:16-alpine",
      "rabbitmq:3-management",
      "redis:7-alpine",
    ]);
  });

  it("mounts at an absolute path", () => {
    for (const preset of PRESETS) {
      if (!preset.volume) continue;
      // A relative mount path is accepted by the schema and silently useless: Railway would
      // resolve it against the image's WORKDIR, which the catalog does not know.
      expect(preset.volume.mountPath.startsWith("/"), preset.value).toBe(true);
      expect(preset.volume.mountPath.endsWith("/"), preset.value).toBe(false);
    }
  });

  it("matches on the repository, so a different tag still gets its volume", () => {
    expect(presetVolumeFor("postgres:17")).toEqual({
      mountPath: "/var/lib/postgresql/data",
    });
    expect(presetVolumeFor("redis")).toEqual({ mountPath: "/data" });
  });

  /*
   * The two undefineds a caller has to tell apart, pinned side by side because the spin-up
   * note is built on the difference: an image the catalog knows keeps nothing says nothing,
   * and an image it has never heard of warns. `presetFor` is what separates them.
   */
  it("is undefined both for a stateless preset and for an unknown image", () => {
    expect(presetVolumeFor("nginx:alpine")).toBeUndefined();
    expect(presetFor("nginx:alpine")).toBeDefined();

    expect(presetVolumeFor("couchdb:3")).toBeUndefined();
    expect(presetFor("couchdb:3")).toBeUndefined();
  });

  /*
   * PGDATA and the mount path are one decision written in two places, and the catalog says
   * so. This is what fails if someone changes one of them.
   */
  it("points postgres's PGDATA at a subdirectory of its own mount", () => {
    const postgres = presetFor("postgres:16-alpine");
    const mountPath = postgres?.volume?.mountPath;
    const pgdata = postgres?.variables?.find((v) => v.name === "PGDATA");

    expect(mountPath).toBeDefined();
    expect(pgdata).toBeDefined();
    expect(pgdata && "value" in pgdata ? pgdata.value : "").toMatch(
      new RegExp(`^${mountPath}/.+`),
    );
  });
});

describe("httpPortFor", () => {
  it("answers the catalog's port for a web preset", () => {
    expect(httpPortFor("nginx:alpine")).toBe(80);
    expect(httpPortFor("caddy:2-alpine")).toBe(80);
  });

  it("matches on the repository, so a different tag still resolves", () => {
    expect(httpPortFor("nginx:1.27")).toBe(80);
  });

  /*
   * The two undefineds, side by side for the same reason presetVolumeFor pins them: the
   * spin-up form seeds a blank port for both, and the row control omits `targetPort` for
   * the second. `presetFor` is what separates "serves nothing" from "never heard of it".
   */
  it("is undefined both for a preset that serves no HTTP and for an unknown image", () => {
    expect(httpPortFor("redis:7-alpine")).toBeUndefined();
    expect(presetFor("redis:7-alpine")).toBeDefined();

    expect(httpPortFor("ghcr.io/owner/api:1")).toBeUndefined();
    expect(presetFor("ghcr.io/owner/api:1")).toBeUndefined();
  });

  /*
   * The rule the field exists for. Every web preset is reachable, because a web server the
   * user cannot open is the defect T-485 was raised about — and rabbitmq is reachable while
   * NOT being in that group, which is why the port is its own field rather than read off
   * `groupKey`.
   */
  it("gives every web preset a port, and is not the same thing as the web group", () => {
    for (const preset of PRESETS.filter((p) => p.groupKey === "web")) {
      expect(preset.httpPort, preset.value).toBeDefined();
    }

    const rabbit = presetFor("rabbitmq:3-management");
    expect(rabbit?.groupKey).toBe("queue");
    // The management console the `-management` tag adds, never 5672: a public hostname in
    // front of the broker port would be an unauthenticated AMQP endpoint on the internet.
    expect(rabbit?.httpPort).toBe(15672);
  });

  /*
   * A port the catalog seeds is a port the form then submits, so every one of them has to
   * survive the rule that bounds the field it lands in.
   */
  it("only declares ports the spin-up schema accepts", () => {
    for (const preset of PRESETS) {
      if (preset.httpPort === undefined) continue;
      const parsed = spinUpSchema.safeParse({
        projectId: "11111111-1111-4111-8111-111111111111",
        environmentId: "22222222-2222-4222-8222-222222222222",
        name: "web",
        image: preset.value,
        port: String(preset.httpPort),
        idempotencyKey: "a".repeat(16),
      });
      expect(parsed.success, preset.value).toBe(true);
    }
  });
});
