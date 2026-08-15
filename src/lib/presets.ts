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

/**
 * Where an image keeps the data that has to outlive its container.
 *
 * A Railway volume is attached to a service and mounted at one path, so this is the whole
 * of it — there is no size here because `VolumeCreateInput` has no size member and Railway
 * provisions at the deployer's plan default (500 MB on the accounts this was probed
 * against). See `createContainer` in ./railway/api.ts.
 */
export type PresetVolume = {
  /** Absolute path inside the container. */
  mountPath: string;
};

export type Preset = {
  /** The image reference. Also the option value, and what lands in FormData. */
  value: string;
  labelKey: PresetLabelKey;
  groupKey: PresetGroupKey;
  /** Environment the image needs to boot. Absent for images that boot bare. */
  variables?: readonly PresetVariable[];
  /**
   * Absent means the catalog asserts this image keeps nothing worth keeping — nginx
   * serving a baked-in document root, whoami answering from memory — and NOT "we did not
   * get round to it". The spin-up form reads that distinction: a preset with no volume
   * says nothing, while an image matching no preset at all says the app does not know
   * where it stores data. Adding an entry here without checking the image would turn a
   * statement into a guess.
   */
  volume?: PresetVolume;
  /**
   * The port this image serves HTTP on, and therefore whether it gets a public address.
   *
   * Absent means the image serves no HTTP and a spin-up mints no domain for it — redis
   * speaks its own wire protocol, and a hostname in front of it would be a link that
   * answers a browser with nothing.
   *
   * A field of its own rather than `groupKey === "web"`, and rabbitmq is why: it is a
   * message queue whose image ships a management UI on 15672, so the group says one thing
   * and the port says another. Reading reachability off the group would have got exactly
   * one entry in this catalog wrong, which is the kind of rule that looks correct until
   * the catalog grows.
   *
   * The number is the port INSIDE the container, not the one the edge listens on — Railway
   * always answers 443 — and it is what `ServiceDomainCreateInput.targetPort` takes.
   */
  httpPort?: number;
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
 *
 * And every entry that writes state must carry a `volume`. Until T-491 none did, so five
 * of these — six, counting rabbitmq, which the ticket did not — took a generated
 * credential, accepted data, and lost it the next time the container moved. An image whose
 * storage was not checked belongs in neither camp: leave it out of the catalog rather than
 * guess a mount path for it.
 */
/**
 * The entry the spin-up form opens on, named rather than read back out of the list.
 *
 * `DEFAULT_IMAGE` below used to be `PRESETS[0]!.value`, which made "the default is the
 * first one" a fact about array order that nothing stated and reordering the catalog
 * would silently change. It is also why that line needed an assertion at all: the
 * `readonly Preset[]` annotation widens the literal away from a tuple, so index 0 is
 * `Preset | undefined` under `noUncheckedIndexedAccess` however obviously it is not.
 */
const DEFAULT_PRESET: Preset = {
  value: "redis:7-alpine",
  labelKey: "redis",
  groupKey: "cache",
  // The RDB snapshot path, and where an appendonly file would go too.
  volume: { mountPath: "/data" },
};

export const PRESETS: readonly Preset[] = [
  DEFAULT_PRESET,
  // No volume, and that is the image: memcached holds everything in memory by design.
  { value: "memcached:1-alpine", labelKey: "memcached", groupKey: "cache" },

  // All four serve on 80 out of the box, which is the reason these are the presets: an
  // image needing a port argument to listen anywhere is an image this app cannot configure
  // (ADR-6 — image and environment, no command override).
  { value: "nginx:alpine", labelKey: "nginx", groupKey: "web", httpPort: 80 },
  { value: "httpd:alpine", labelKey: "apache", groupKey: "web", httpPort: 80 },
  { value: "caddy:2-alpine", labelKey: "caddy", groupKey: "web", httpPort: 80 },
  { value: "traefik/whoami", labelKey: "whoami", groupKey: "web", httpPort: 80 },

  {
    value: "postgres:16-alpine",
    labelKey: "postgres",
    groupKey: "database",
    variables: [
      { name: "POSTGRES_PASSWORD", generate: "password" },
      /*
       * Coupled to the `mountPath` below, and it is the mount that makes it necessary.
       *
       * The official image runs `initdb` into `$PGDATA` and refuses a directory that is
       * not empty. A freshly provisioned volume is an ext4 filesystem with `lost+found`
       * in it, so mounting at the default `/var/lib/postgresql/data` turns the first boot
       * into `directory "/var/lib/postgresql/data" exists but is not empty` and a restart
       * loop — the exact failure the preset catalog exists to prevent. Pointing PGDATA at
       * a subdirectory of the mount gives initdb an empty directory it creates itself.
       *
       * An editable row rather than a hidden variable, on the same argument as
       * MONGO_INITDB_ROOT_USERNAME below: the editor shows what will be set. Change one of
       * these two and you must change the other.
       */
      { name: "PGDATA", value: "/var/lib/postgresql/data/pgdata" },
    ],
    volume: { mountPath: "/var/lib/postgresql/data" },
  },
  {
    value: "mysql:8",
    labelKey: "mysql",
    groupKey: "database",
    variables: [{ name: "MYSQL_ROOT_PASSWORD", generate: "password" }],
    // No PGDATA-style dance needed: the entrypoint looks for its own `mysql` subdirectory
    // rather than requiring the datadir to be empty, so `lost+found` does not stop it.
    volume: { mountPath: "/var/lib/mysql" },
  },
  {
    value: "mariadb:11",
    labelKey: "mariadb",
    groupKey: "database",
    variables: [{ name: "MARIADB_ROOT_PASSWORD", generate: "password" }],
    volume: { mountPath: "/var/lib/mysql" },
  },
  {
    value: "mongo:7",
    labelKey: "mongo",
    groupKey: "database",
    variables: [
      { name: "MONGO_INITDB_ROOT_USERNAME", value: "root" },
      { name: "MONGO_INITDB_ROOT_PASSWORD", generate: "password" },
    ],
    volume: { mountPath: "/data/db" },
  },

  {
    value: "rabbitmq:3-management",
    labelKey: "rabbitmq",
    groupKey: "queue",
    variables: [
      { name: "RABBITMQ_DEFAULT_USER", value: "admin" },
      { name: "RABBITMQ_DEFAULT_PASS", generate: "password" },
    ],
    /*
     * The sixth stateful preset, and T-491 named five. Durable queues, exchange and
     * binding definitions and the Mnesia database all live here — a broker that loses them
     * on restart silently drops messages a publisher was told were safe, which is a worse
     * failure than an empty database because nothing about it looks broken.
     */
    volume: { mountPath: "/var/lib/rabbitmq" },
    /*
     * The management UI, not the broker.
     *
     * 5672 is where AMQP clients connect and it is deliberately NOT what this points at: a
     * public hostname in front of the broker port would be a link a browser cannot use and
     * an unauthenticated queue endpoint on the open internet. 15672 is the HTTP console the
     * `-management` tag exists to add, it is a page, and it asks for the credentials this
     * preset already generates.
     */
    httpPort: 15672,
  },
  // Core NATS is in-memory; JetStream would need a volume, and enabling it needs an
  // argument this app cannot pass (ADR-6: image and environment, no command override).
  { value: "nats:2-alpine", labelKey: "nats", groupKey: "queue" },
] as const;

export const DEFAULT_IMAGE = DEFAULT_PRESET.value;

/**
 * The repository part of a reference: registry and path, with tag and digest removed.
 *
 * A tag is the last colon segment only when it contains no slash — `localhost:5000/app`
 * is a registry host and a path, not a tagged image, and treating that colon as a tag
 * separator would mangle it.
 */
export function repositoryOf(image: string): string {
  // Destructured with a default rather than asserted: `split` always yields at least one
  // element, so the fallback is unreachable, but writing it costs nothing and needs no
  // claim about a built-in that the compiler cannot check.
  const [beforeDigest = image] = image.split("@");
  const withoutDigest = beforeDigest.trim();
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

/**
 * Where this image's data has to be kept, or undefined.
 *
 * Undefined answers two different questions the same way, and the callers have to tell
 * them apart themselves: the catalog knows this image stores nothing (memcached), or the
 * catalog has never heard of this image at all (`couchdb:3`). `presetFor` is what
 * separates them — see the note on `Preset.volume`.
 *
 * Repository-matched like everything else here, so `postgres:17` mounts where
 * `postgres:16-alpine` does.
 */
export function presetVolumeFor(image: string): PresetVolume | undefined {
  return presetFor(image)?.volume;
}

/**
 * The port this image serves HTTP on, or undefined.
 *
 * Undefined answers two questions the same way, exactly as `presetVolumeFor` does: the
 * catalog knows this image serves no HTTP (redis), or it has never heard of the image at
 * all (`ghcr.io/owner/api`). The two callers want different things from that, which is why
 * this returns the port rather than a boolean:
 *
 *   - The spin-up form seeds its port field with it, so a person spinning up nginx gets 80
 *     without typing, and a person spinning up a custom image gets a blank field to fill in.
 *   - The row's domain control passes it through when it exists and omits `targetPort`
 *     otherwise, letting Railway infer from the running deployment.
 *
 * Repository-matched like everything else here, so `nginx:1.27` resolves as `nginx:alpine`.
 */
export function httpPortFor(image: string): number | undefined {
  return presetFor(image)?.httpPort;
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
