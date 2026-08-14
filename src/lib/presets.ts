import type messages from "../../messages/en.json";

/*
 * The preset catalog.
 *
 * Deliberately NOT `server-only`: the client reads the labels to render the image list and
 * the variables to seed the environment editor's default rows, and the Server Action reads
 * the same entries to decide which names it may mint a credential for.
 *
 * That second reading is what remains of the property this module used to carry alone.
 * Until T-487 the client sent no variables at all, so the environment was whatever the
 * catalog said and nothing else. It now sends them — but generation is still granted by
 * the catalog rather than asked for by the request, and this is the file that grants it.
 * See `resolveVariables` in ./railway/secrets and SECURITY.md, "Input surfaces".
 *
 * `import type` on the catalog is erased at compile time, so nothing here pulls the
 * message JSON into the client bundle; it only makes a mistyped key fail `tsc`.
 */

type PresetLabelKey = keyof (typeof messages)["presets"]["labels"];
type PresetGroupKey = keyof (typeof messages)["presets"]["groups"];

export type PresetVariable =
  | { name: string; value: string }
  /**
   * Generated fresh per creation, server-side.
   *
   * The value is never sent to the client, never logged, and never stored here. Railway's
   * own service → Variables page is where the user reads it, which is the same place they
   * would read any other Railway secret — this app holds no database (ADR-4) and is not
   * going to become a password manager.
   *
   * T-487 made that argument stronger rather than weaker. A user who needs to know the
   * password now types their own into the editor, so generation is only the default for
   * the users who do not care what it is — and a default nobody has to read is one this
   * app has no reason to show.
   */
  | { name: string; generate: "password" };

export type Preset = {
  /** The image reference. Also the option value, and what lands in FormData. */
  value: string;
  labelKey: PresetLabelKey;
  groupKey: PresetGroupKey;
  /** Environment the image needs to boot. Absent for images that boot bare. */
  variables?: readonly PresetVariable[];
};

/**
 * Images offered on the spin-up form.
 *
 * The original four were chosen because they stay up with no configuration at all — a
 * preset that boots and immediately exits shows a crash loop and reads as a bug in this
 * app rather than in the image. That constraint has not gone away; what changed is that
 * the create path can now set the environment a database needs, so "no configuration
 * required" is satisfied by supplying it rather than by avoiding the image.
 *
 * Every entry here must either boot bare or carry the variables that make it boot.
 */
export const PRESETS: readonly Preset[] = [
  { value: "redis:7-alpine", labelKey: "redis", groupKey: "cache" },
  { value: "memcached:1-alpine", labelKey: "memcached", groupKey: "cache" },

  { value: "nginx:alpine", labelKey: "nginx", groupKey: "web" },
  { value: "httpd:alpine", labelKey: "apache", groupKey: "web" },
  { value: "caddy:2-alpine", labelKey: "caddy", groupKey: "web" },
  { value: "traefik/whoami", labelKey: "whoami", groupKey: "web" },

  {
    value: "postgres:16-alpine",
    labelKey: "postgres",
    groupKey: "database",
    variables: [{ name: "POSTGRES_PASSWORD", generate: "password" }],
  },
  {
    value: "mysql:8",
    labelKey: "mysql",
    groupKey: "database",
    variables: [{ name: "MYSQL_ROOT_PASSWORD", generate: "password" }],
  },
  {
    value: "mariadb:11",
    labelKey: "mariadb",
    groupKey: "database",
    variables: [{ name: "MARIADB_ROOT_PASSWORD", generate: "password" }],
  },
  {
    value: "mongo:7",
    labelKey: "mongo",
    groupKey: "database",
    variables: [
      { name: "MONGO_INITDB_ROOT_USERNAME", value: "root" },
      { name: "MONGO_INITDB_ROOT_PASSWORD", generate: "password" },
    ],
  },

  {
    value: "rabbitmq:3-management",
    labelKey: "rabbitmq",
    groupKey: "queue",
    variables: [
      { name: "RABBITMQ_DEFAULT_USER", value: "admin" },
      { name: "RABBITMQ_DEFAULT_PASS", generate: "password" },
    ],
  },
  { value: "nats:2-alpine", labelKey: "nats", groupKey: "queue" },
] as const;

export const DEFAULT_IMAGE = PRESETS[0]!.value;

/**
 * The repository part of a reference: registry and path, with tag and digest removed.
 *
 * A tag is the last colon segment only when it contains no slash — `localhost:5000/app`
 * is a registry host and a path, not a tagged image, and treating that colon as a tag
 * separator would mangle it.
 */
export function repositoryOf(image: string): string {
  const withoutDigest = image.split("@")[0]!.trim();
  const colon = withoutDigest.lastIndexOf(":");
  if (colon === -1) return withoutDigest;
  const afterColon = withoutDigest.slice(colon + 1);
  return afterColon.includes("/") ? withoutDigest : withoutDigest.slice(0, colon);
}

/**
 * The preset a submitted image belongs to, matched on repository rather than on the
 * exact reference.
 *
 * `postgres:17` is still postgres and still exits without a password, so pinning the
 * match to the catalog's own tag would hand the user the crash loop the preset exists to
 * prevent. `ghcr.io/owner/postgres` is a different repository and matches nothing, which
 * is correct — this app has no idea what that image is.
 */
export function presetFor(image: string): Preset | undefined {
  const repository = repositoryOf(image).toLowerCase();
  return PRESETS.find(
    (preset) => repositoryOf(preset.value).toLowerCase() === repository,
  );
}

/** A catalog default, in the shape the environment editor holds a row in. */
export type PresetVariableDefault = {
  name: string;
  /** Empty for a generated credential: the value does not exist until the server mints it. */
  value: string;
  /** Whether leaving the value blank asks the server for a freshly minted one. */
  generated: boolean;
};

/**
 * The rows the editor starts an image with.
 *
 * The one place the fact that a generated credential has no renderable value is turned
 * into something a form can hold: a blank cell, marked so the editor can say why it is
 * blank. Never a placeholder value, never a sentinel token — anything with content would
 * be a value the browser holds, and the whole point is that it does not.
 *
 * Repository-matched via `presetFor`, so `postgres:17` seeds the row `postgres:16-alpine`
 * does.
 */
export function presetVariableDefaults(
  image: string,
): readonly PresetVariableDefault[] {
  return (presetFor(image)?.variables ?? []).map((variable) =>
    "generate" in variable
      ? { name: variable.name, value: "", generated: true }
      : { name: variable.name, value: variable.value, generated: false },
  );
}
