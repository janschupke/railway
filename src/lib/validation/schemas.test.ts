import { describe, expect, it } from "vitest";
import catalog from "../../../messages/en.json";
import { LIMITS } from "../constants";
import { VALIDATION_KEYS, VALIDATION_VALUES } from "./keys";
import {
  containerActionSchema,
  containerEditSchema,
  environmentCreateSchema,
  projectCreateSchema,
  spinUpSchema,
} from "./schemas";

/**
 * A key the form would have minted, written out rather than generated.
 *
 * A schema test asserts what the rule accepts, and reaching for `newIdempotencyKey()`
 * here would make these cases depend on the generator agreeing with the rule — which is
 * the thing least worth coupling, since the two are deliberately allowed to drift apart
 * as long as the generator stays inside the bounds.
 */
const KEY = "0123456789abcdef0123456789abcdef";

const valid = {
  projectId: "p1",
  environmentId: "e1",
  name: "cache",
  image: "redis:7-alpine",
  idempotencyKey: KEY,
};

/** One row of the variable editor, as the two parallel fields carry it. */
const rows = (...pairs: Array<[string, string]>) => ({
  variableKey: pairs.map(([key]) => key),
  variableValue: pairs.map(([, value]) => value),
});

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
      { ...valid, ...rows(["", "x"]) },
      { ...valid, ...rows(["x".repeat(LIMITS.VARIABLE_NAME_MAX + 1), ""]) },
      { ...valid, ...rows(["1BAD", ""]) },
      { ...valid, ...rows(["RAILWAY_TOKEN", ""]) },
      { ...valid, ...rows(["DUP", ""], ["DUP", ""]) },
      { ...valid, ...rows(["OK", "x".repeat(LIMITS.VARIABLE_VALUE_MAX + 1)]) },
      { ...valid, ...rows(["OK", "line\nbreak"]) },
      {
        ...valid,
        ...rows(
          ...Array.from(
            { length: LIMITS.VARIABLES_MAX + 1 },
            (_unused, index) => [`V${index}`, ""] as [string, string],
          ),
        ),
      },
      {
        ...valid,
        ...rows(["BIG", "x".repeat(LIMITS.VARIABLES_TOTAL_MAX)]),
      },
      { ...valid, variableKey: ["A", "B"], variableValue: [""] },
    ];

    for (const input of cases) {
      const parsed = spinUpSchema.safeParse(input);
      expect(parsed.success).toBe(false);
      for (const issue of parsed.error?.issues ?? []) {
        /*
         * Membership, not the `/^validation\./` prefix this asserted before. A key
         * shaped right but absent from VALIDATION_KEYS passes a prefix test and is then
         * degraded to `actions.invalidForm` by messageForIssue — silently, which is the
         * failure this test exists to catch.
         */
        expect(
          VALIDATION_KEYS.has(issue.message),
          `${issue.message} for ${JSON.stringify(input).slice(0, 60)}`,
        ).toBe(true);
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

describe("environment variables", () => {
  it("accepts a submission that carries no variable fields at all", () => {
    /*
     * The pre-T-487 request shape, and what a form posted without JavaScript still
     * sends. `.default([])` is what keeps it parsing; without it every existing caller
     * fails the type check before any rule carrying a catalog key can fire.
     */
    const parsed = spinUpSchema.safeParse(valid);
    expect(parsed.success && parsed.data.variableKey).toEqual([]);
    expect(parsed.success && parsed.data.variableValue).toEqual([]);
  });

  it.each([
    ["a conventional name", "POSTGRES_PASSWORD"],
    ["a lowercase name", "my_flag"],
    ["a leading underscore", "_PRIVATE"],
    ["digits after the first character", "S3_BUCKET"],
  ])("accepts %s", (_label, key) => {
    expect(spinUpSchema.safeParse({ ...valid, ...rows([key, "v"]) }).success).toBe(
      true,
    );
  });

  it.each([
    ["a leading digit", "1BAD"],
    ["a hyphen", "MY-VAR"],
    ["a space", "MY VAR"],
    ["a dot", "my.var"],
  ])("refuses %s", (_label, key) => {
    expect(spinUpSchema.safeParse({ ...valid, ...rows([key, "v"]) }).success).toBe(
      false,
    );
  });

  it("refuses the namespace Railway sets itself, whatever its case", () => {
    for (const key of ["RAILWAY_TOKEN", "railway_token", "Railway_Token"]) {
      const parsed = spinUpSchema.safeParse({ ...valid, ...rows([key, "v"]) });
      expect(parsed.success, key).toBe(false);
      expect(parsed.error?.issues[0]?.message).toBe("validation.variableNameReserved");
    }
  });

  it("keeps a value with a tab, and refuses one with a line break", () => {
    /*
     * The distinction is the whole rule. A tab is a character inside a value; a line
     * break changes the shape of what is being set — and an <input> silently strips it
     * from a pasted string, so without this rule the user's secret is truncated with no
     * signal at all.
     */
    expect(spinUpSchema.safeParse({ ...valid, ...rows(["A", "a\tb"]) }).success).toBe(
      true,
    );
    for (const value of ["a\nb", "a\rb", "a\u0000b"]) {
      const parsed = spinUpSchema.safeParse({ ...valid, ...rows(["A", value]) });
      expect(parsed.success, JSON.stringify(value)).toBe(false);
      expect(parsed.error?.issues[0]?.message).toBe("validation.variableValueInvalid");
    }
  });

  it("accepts an empty value, which is what asks the catalog for a generated one", () => {
    expect(spinUpSchema.safeParse({ ...valid, ...rows(["A", ""]) }).success).toBe(true);
  });

  it("refuses a value with no name, rather than dropping the row", () => {
    // The user typed something and deserves to be told why it was not saved.
    const parsed = spinUpSchema.safeParse({ ...valid, ...rows(["", "orphan"]) });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe("validation.variableNameRequired");
  });

  it("refuses a duplicate name, attributing it to the second occurrence", () => {
    const parsed = spinUpSchema.safeParse({
      ...valid,
      ...rows(["KEEP", "1"], ["DUP", "2"], ["DUP", "3"]),
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe("validation.variableNameDuplicate");
    expect(parsed.error?.issues[0]?.path).toEqual(["variableKey", 2]);
  });

  it("treats names differing only in case as different variables", () => {
    // `Foo` and `FOO` are two variables on Linux; folding here would refuse a legal pair.
    expect(
      spinUpSchema.safeParse({ ...valid, ...rows(["Foo", "1"], ["FOO", "2"]) }).success,
    ).toBe(true);
  });

  it.each([
    ["at the count cap", LIMITS.VARIABLES_MAX, true],
    ["one past the count cap", LIMITS.VARIABLES_MAX + 1, false],
  ])("is %s", (_label, count, expected) => {
    const parsed = spinUpSchema.safeParse({
      ...valid,
      ...rows(
        ...Array.from(
          { length: count },
          (_unused, index) => [`V${index}`, ""] as [string, string],
        ),
      ),
    });
    expect(parsed.success).toBe(expected);
  });

  it("bounds the whole submission, not only each row", () => {
    /*
     * The per-row caps multiply well past anything a person types, so this is the bound
     * that actually holds. Both sides, because the negative branch of a size check is
     * the one that silently stops being reachable.
     */
    const full = (count: number) =>
      rows(
        ...Array.from(
          { length: count },
          (_unused, index) =>
            [`V${index}`, "x".repeat(LIMITS.VARIABLE_VALUE_MAX)] as [string, string],
        ),
      );

    // Seven maximal rows is 14 350 characters; eight is 16 400. Neither row breaks a
    // per-row cap, which is the point — only the total does.
    expect(spinUpSchema.safeParse({ ...valid, ...full(7) }).success).toBe(true);

    const parsed = spinUpSchema.safeParse({ ...valid, ...full(8) });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe("validation.variablesTooLarge");
  });

  it("refuses two lists of different lengths without validating across rows", () => {
    // Not something the row markup can produce; it emits both cells or neither.
    const parsed = spinUpSchema.safeParse({
      ...valid,
      variableKey: ["A", "B"],
      variableValue: ["only-one"],
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe("validation.variablesMalformed");
    expect(parsed.error?.issues[0]?.path).toEqual(["variableKey"]);
  });

  describe("issue paths", () => {
    /*
     * These pin the shape ActionResult's `field` + `index` is read from. They are the
     * reason the schema is two parallel arrays rather than an array of pairs: zod builds
     * the row index into the path itself, so nothing has to reconstruct it.
     */
    it("names the field and the row for a bad name", () => {
      const parsed = spinUpSchema.safeParse({
        ...valid,
        ...rows(["OK", ""], ["ALSO_OK", ""], ["1bad", ""]),
      });
      expect(parsed.error?.issues[0]?.path).toEqual(["variableKey", 2]);
      expect(typeof parsed.error?.issues[0]?.path[1]).toBe("number");
    });

    it("names the field and the row for a bad value", () => {
      const parsed = spinUpSchema.safeParse({ ...valid, ...rows(["OK", "a\nb"]) });
      expect(parsed.error?.issues[0]?.path).toEqual(["variableValue", 0]);
    });

    it("carries no row index for a rule about the whole list", () => {
      // These have to reach the user as a toast; the form has no row to attach them to.
      const parsed = spinUpSchema.safeParse({
        ...valid,
        ...rows(
          ...Array.from(
            { length: LIMITS.VARIABLES_MAX + 1 },
            (_unused, index) => [`V${index}`, ""] as [string, string],
          ),
        ),
      });
      expect(parsed.error?.issues[0]?.path).toEqual(["variableKey"]);
      expect(parsed.error?.issues[0]?.path[1]).toBeUndefined();
    });

    it("reports a bad container name ahead of a bad variable row", () => {
      /*
       * The action reports issues[0] only, so this ordering decides which of two real
       * problems the user is told about. Shape issues are pushed before check issues,
       * and `name` is declared before `variableKey` — both of which this pins, because
       * neither is something this repo controls.
       */
      const parsed = spinUpSchema.safeParse({
        ...valid,
        name: "x".repeat(LIMITS.CONTAINER_NAME_MAX + 1),
        ...rows(["1bad", ""]),
      });
      expect(parsed.error?.issues[0]?.path[0]).toBe("name");
    });

    it("reports a bad container name ahead of a missing submission key", () => {
      /*
       * Same ordering rule, and the reason `idempotencyKey` is declared last. Its message
       * is "reload the page", which is true and useless to somebody whose real problem is
       * a name they could have corrected — so it must never outrank one.
       */
      const parsed = spinUpSchema.safeParse({
        ...valid,
        name: "",
        idempotencyKey: "",
      });
      expect(parsed.error?.issues[0]?.path[0]).toBe("name");
    });
  });

  describe("the submission key", () => {
    it("accepts one at either bound", () => {
      for (const key of ["k".repeat(16), "k".repeat(64), "aB0_-".repeat(4)]) {
        expect(
          spinUpSchema.safeParse({ ...valid, idempotencyKey: key }).success,
          key,
        ).toBe(true);
      }
    });

    it("refuses one too short to be unguessable", () => {
      // The floor is the security half of the rule: a guessed key is answered with
      // somebody else's result instead of the container they asked for.
      const parsed = spinUpSchema.safeParse({
        ...valid,
        idempotencyKey: "k".repeat(15),
      });
      expect(parsed.error?.issues[0]?.message).toBe("validation.submissionInvalid");
    });

    it("refuses one long enough to be a memory problem", () => {
      // The ceiling is the other half: this string becomes part of a key in a map that
      // lives as long as the process.
      const parsed = spinUpSchema.safeParse({
        ...valid,
        idempotencyKey: "k".repeat(65),
      });
      expect(parsed.error?.issues[0]?.message).toBe("validation.submissionInvalid");
    });

    it("refuses one that is missing, blank, or outside the charset", () => {
      for (const key of ["", "   ", "0123456789abcdef!", "0123456789 abcdef"]) {
        const parsed = spinUpSchema.safeParse({ ...valid, idempotencyKey: key });
        expect(parsed.error?.issues[0]?.message, JSON.stringify(key)).toBe(
          "validation.submissionInvalid",
        );
      }
    });
  });
});

describe("containerActionSchema", () => {
  it("requires all three references", () => {
    expect(
      containerActionSchema.safeParse({
        projectId: "p1",
        environmentId: "e1",
        serviceId: "s1",
      }).success,
    ).toBe(true);
    expect(
      containerActionSchema.safeParse({ projectId: "p1", environmentId: "e1" }).success,
    ).toBe(false);
    expect(
      containerActionSchema.safeParse({
        projectId: "",
        environmentId: "e1",
        serviceId: "s1",
      }).success,
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
    expect(containerActionSchema.safeParse({ ...base, serviceId: value }).success).toBe(
      false,
    );
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
    const parsed = containerActionSchema.safeParse({
      ...base,
      serviceId: "proj/../admin",
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(VALIDATION_KEYS.has(parsed.error.issues[0]!.message)).toBe(true);
  });

  it("still accepts what Railway actually issues", () => {
    expect(
      containerActionSchema.safeParse({
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
    collect(spinUpSchema.safeParse({ ...spinUp(), ...rows(["", "x"]) }));
    collect(spinUpSchema.safeParse({ ...spinUp(), ...rows(["1bad", ""]) }));
    collect(spinUpSchema.safeParse({ ...spinUp(), ...rows(["RAILWAY_X", ""]) }));
    collect(spinUpSchema.safeParse({ ...spinUp(), ...rows(["D", ""], ["D", ""]) }));
    collect(spinUpSchema.safeParse({ ...spinUp(), ...rows(["X".repeat(500), ""]) }));
    collect(spinUpSchema.safeParse({ ...spinUp(), ...rows(["A", "x".repeat(5000)]) }));
    collect(spinUpSchema.safeParse({ ...spinUp(), ...rows(["A", "a\nb"]) }));
    collect(
      spinUpSchema.safeParse({
        ...spinUp(),
        ...rows(
          ...Array.from(
            { length: LIMITS.VARIABLES_MAX + 1 },
            (_unused, index) => [`V${index}`, ""] as [string, string],
          ),
        ),
      }),
    );
    collect(
      spinUpSchema.safeParse({
        ...spinUp(),
        ...rows(["A", "x".repeat(LIMITS.VARIABLES_TOTAL_MAX)]),
      }),
    );
    collect(
      spinUpSchema.safeParse({
        ...spinUp(),
        variableKey: ["A", "B"],
        variableValue: [""],
      }),
    );
    collect(spinUpSchema.safeParse({ ...spinUp(), port: "0" }));
    collect(spinUpSchema.safeParse({ ...spinUp(), region: "US_WEST" }));
    collect(spinUpSchema.safeParse({ ...spinUp(), region: "x".repeat(100) }));
    collect(spinUpSchema.safeParse({ ...spinUp(), replicas: "nope" }));
    collect(spinUpSchema.safeParse({ ...spinUp(), replicas: "999" }));
    collect(spinUpSchema.safeParse({ ...spinUp(), cpu: "nope" }));
    collect(spinUpSchema.safeParse({ ...spinUp(), cpu: "999" }));
    collect(spinUpSchema.safeParse({ ...spinUp(), memory: "nope" }));
    collect(spinUpSchema.safeParse({ ...spinUp(), memory: "999" }));
    collect(spinUpSchema.safeParse({ ...spinUp(), restartPolicy: "sometimes" }));
    collect(spinUpSchema.safeParse({ ...spinUp(), restartRetries: "nope" }));
    collect(spinUpSchema.safeParse({ ...spinUp(), restartRetries: "999" }));
    collect(spinUpSchema.safeParse({ ...spinUp(), startCommand: "a\nb" }));
    collect(spinUpSchema.safeParse({ ...spinUp(), startCommand: "x".repeat(5000) }));
    collect(spinUpSchema.safeParse({ ...spinUp(), idempotencyKey: "" }));
    collect(spinUpSchema.safeParse({ ...spinUp(), idempotencyKey: "too-short" }));
    collect(containerActionSchema.safeParse({ ...spinDown(), serviceId: "" }));
    collect(containerActionSchema.safeParse({ ...spinDown(), serviceId: "s/1" }));

    expect(messages.size).toBeGreaterThan(0);
    for (const message of messages) expect(VALIDATION_KEYS.has(message)).toBe(true);
  });

  it("names only keys the catalog actually holds", () => {
    /*
     * The other half of the two-edit rule, which messages.test.ts already checks for
     * MessageKey. A key registered here but missing from en.json reaches the user as its
     * own dotted path, because next-intl echoes an unknown key back verbatim.
     */
    for (const key of VALIDATION_KEYS) {
      const leaf = key
        .split(".")
        .reduce<unknown>(
          (node, part) =>
            typeof node === "object" && node !== null
              ? (node as Record<string, unknown>)[part]
              : undefined,
          catalog,
        );
      expect(typeof leaf, `${key} is missing from messages/en.json`).toBe("string");
    }
  });

  it("reaches every key the catalog holds", () => {
    /*
     * The direction that was missing, and the one messages.test.ts already checks for
     * `errors.*`: "every leaf the catalog holds is reachable from here". Without it a
     * `validation.*` entry can outlive the rule that named it — dead copy nobody edits,
     * still translated, still shipped, and indistinguishable from a live one.
     *
     * Note the sibling test above is one-directional by construction: it drives the
     * schemas with a hand-written list of triggering inputs, so it proves every key it
     * *reached* is registered, not that every registered key is reachable. This closes as
     * much of the gap as can be closed without deriving reachability from a zod schema.
     */
    const namespace: Record<string, unknown> = catalog.validation;
    // A namespace this file could not find would make the loop below vacuous and green.
    expect(Object.keys(namespace).length).toBeGreaterThan(30);

    for (const leaf of Object.keys(namespace)) {
      const key = `validation.${leaf}`;
      expect(
        VALIDATION_KEYS.has(key),
        `${key} is in en.json but no rule names it`,
      ).toBe(true);
    }
  });

  it("registers every interpolated key as a key in its own right", () => {
    // VALIDATION_VALUES only supplies arguments; a key absent from the set above is
    // degraded to actions.invalidForm before those arguments are ever read.
    for (const key of Object.keys(VALIDATION_VALUES)) {
      expect(VALIDATION_KEYS.has(key), key).toBe(true);
    }
  });

  const spinUp = () => ({
    projectId: "p1",
    environmentId: "e1",
    name: "cache",
    image: "redis:7",
    idempotencyKey: KEY,
  });
  const spinDown = () => ({ projectId: "p1", environmentId: "e1", serviceId: "s1" });
});

describe("projectCreateSchema", () => {
  it("accepts a name with the punctuation people actually use", () => {
    /*
     * No charset rule on purpose. The name is not slugged, not prefixed and not
     * interpolated into a path — Railway stores it and renders it back — so a pattern here
     * would only reject project names that work perfectly well.
     */
    for (const name of [
      "Client work, 2026",
      "Ada's sandbox",
      "api/v2 spike",
      "\u91cd\u8981",
    ]) {
      expect(projectCreateSchema.safeParse({ name }).success, name).toBe(true);
    }
  });

  it("trims, so whitespace is not a name", () => {
    expect(projectCreateSchema.safeParse({ name: "  hi  " }).data?.name).toBe("hi");
    expect(
      projectCreateSchema.safeParse({ name: "   " }).error?.issues[0]?.message,
    ).toBe("validation.projectNameRequired");
  });

  it("bounds the length at LIMITS.PROJECT_NAME_MAX", () => {
    expect(
      projectCreateSchema.safeParse({ name: "x".repeat(LIMITS.PROJECT_NAME_MAX) })
        .success,
    ).toBe(true);
    expect(
      projectCreateSchema.safeParse({ name: "x".repeat(LIMITS.PROJECT_NAME_MAX + 1) })
        .error?.issues[0]?.message,
    ).toBe("validation.projectNameTooLong");
  });

  it("accepts a workspace id, which is where the project is created", () => {
    expect(
      projectCreateSchema.safeParse({ name: "Client work", workspaceId: "ws_1" }).data
        ?.workspaceId,
    ).toBe("ws_1");
  });

  it.each([
    ["blank, as the personal option submits it", ""],
    ["absent, as a dialog with no select leaves it", undefined],
  ])("reads a %s workspace as the personal account", (_case, workspaceId) => {
    // Undefined rather than "": the mutation omits the member entirely, because an absent
    // workspace is Railway's own spelling of "personal" and null is not.
    const parsed = projectCreateSchema.safeParse({
      name: "Client work",
      ...(workspaceId === undefined ? {} : { workspaceId }),
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty("workspaceId", "");
    expect(parsed.data?.workspaceId).toBeUndefined();
  });

  it("holds the workspace id to the Railway identifier pattern", () => {
    // Only reachable from a stale page or a hand-crafted request — this app renders the
    // options — so the message is the one that says to reload rather than to fix a field.
    expect(
      projectCreateSchema.safeParse({ name: "Client work", workspaceId: "ws/1" }).error
        ?.issues[0]?.message,
    ).toBe("validation.referenceInvalid");
  });
});

describe("environmentCreateSchema", () => {
  const valid = { projectId: "p1", name: "staging" };

  it("accepts a project id and a name", () => {
    expect(environmentCreateSchema.safeParse(valid).success).toBe(true);
  });

  it("holds the project id to the Railway identifier pattern", () => {
    // The same reasoning as every other id arriving from a form: path separators and
    // unbounded input must not reach the GraphQL layer.
    const result = environmentCreateSchema.safeParse({ ...valid, projectId: "p/1" });
    expect(result.error?.issues[0]?.message).toBe("validation.referenceInvalid");
    expect(result.error?.issues[0]?.path[0]).toBe("projectId");
  });

  it("bounds the name at LIMITS.ENVIRONMENT_NAME_MAX and attributes it to `name`", () => {
    const result = environmentCreateSchema.safeParse({
      ...valid,
      name: "x".repeat(LIMITS.ENVIRONMENT_NAME_MAX + 1),
    });
    expect(result.error?.issues[0]?.message).toBe("validation.environmentNameTooLong");
    // The action maps this path to the `environmentName` field; a different path would
    // send the message to a toast instead of the input.
    expect(result.error?.issues[0]?.path[0]).toBe("name");
  });

  it("refuses a blank name", () => {
    expect(
      environmentCreateSchema.safeParse({ ...valid, name: "" }).error?.issues[0]
        ?.message,
    ).toBe("validation.environmentNameRequired");
  });
});

describe("the spin-up port", () => {
  const parsePort = (port: string) => spinUpSchema.safeParse({ ...valid, port });

  it("accepts the ports the catalog seeds", () => {
    expect(parsePort("80").data?.port).toBe(80);
    expect(parsePort("15672").data?.port).toBe(15672);
  });

  /*
   * The whole point of the field being optional. A blank port is what every database preset
   * submits and what a person types when they clear the 80 nginx seeded — it is a request
   * for no public address, not an incomplete form.
   */
  it("treats blank and absent alike, as no domain at all", () => {
    expect(parsePort("").success).toBe(true);
    expect(parsePort("").data?.port).toBeUndefined();
    expect(spinUpSchema.safeParse(valid).data?.port).toBeUndefined();
  });

  it("trims, so a stray space is not a port", () => {
    expect(parsePort("  8080  ").data?.port).toBe(8080);
    expect(parsePort("   ").data?.port).toBeUndefined();
  });

  it("accepts both ends of the range and refuses just outside it", () => {
    expect(parsePort(String(LIMITS.PORT_MIN)).success).toBe(true);
    expect(parsePort(String(LIMITS.PORT_MAX)).success).toBe(true);
    expect(parsePort("0").error?.issues[0]?.message).toBe("validation.portInvalid");
    expect(parsePort(String(LIMITS.PORT_MAX + 1)).error?.issues[0]?.message).toBe(
      "validation.portInvalid",
    );
  });

  /*
   * A port is decimal digits, and every entry here is a value one of the obvious
   * implementations would have accepted: parseInt reads "80abc" as 80, and Number reads
   * "0x50" and "1e3" as 80 and 1000. Both turn a typo into a working port aimed somewhere
   * nobody meant.
   */
  it("refuses anything that is not plainly a decimal number", () => {
    for (const bad of ["80abc", "8 0", "eighty", "80.5", "-80", "0x50", "1e3", "+80"]) {
      expect(parsePort(bad).error?.issues[0]?.message, bad).toBe(
        "validation.portInvalid",
      );
    }
  });

  it("attributes the failure to the port field, so it renders inline", () => {
    // A path of anything else sends the message to a toast, where it names no field the
    // user can go and correct.
    expect(parsePort("0").error?.issues[0]?.path[0]).toBe("port");
  });

  it("names a catalog key the action can resolve, with both its arguments", () => {
    expect(VALIDATION_KEYS.has("validation.portInvalid")).toBe(true);
    expect(VALIDATION_VALUES["validation.portInvalid"]).toEqual({
      min: LIMITS.PORT_MIN,
      max: LIMITS.PORT_MAX,
    });
    expect(catalog.validation.portInvalid).toContain("{min");
  });
});

describe("the advanced resource controls", () => {
  const parse = (over: Record<string, string>) =>
    spinUpSchema.safeParse({ ...valid, ...over });
  const messageOf = (over: Record<string, string>) =>
    parse(over).error?.issues[0]?.message;

  /*
   * Blank is the ordinary value for all seven, not a mistake — it is what every form nobody
   * opened the panel on submits, and it is what "leave it to Railway" is spelled as all the
   * way down to the mutation input. `undefined` rather than 0 or "" is the half that matters:
   * a falsy value and an absent one have to stay tellable apart, or a blank replica field
   * asks Railway for zero replicas.
   */
  it("treats every field as absent when it is blank", () => {
    const parsed = parse({
      region: "",
      replicas: "",
      cpu: "",
      memory: "",
      restartPolicy: "",
      restartRetries: "",
      startCommand: "",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.region).toBeUndefined();
    expect(parsed.data?.replicas).toBeUndefined();
    expect(parsed.data?.cpu).toBeUndefined();
    expect(parsed.data?.memory).toBeUndefined();
    expect(parsed.data?.restartPolicy).toBeUndefined();
    expect(parsed.data?.restartRetries).toBeUndefined();
    expect(parsed.data?.startCommand).toBeUndefined();
  });

  it("parses a fully filled panel into the values the mutations take", () => {
    const parsed = parse({
      region: "europe-west4-drams3a",
      replicas: "3",
      cpu: "0.5",
      memory: "2",
      restartPolicy: "ON_FAILURE",
      restartRetries: "0",
      startCommand: "redis-server --appendonly yes",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({
      region: "europe-west4-drams3a",
      replicas: 3,
      cpu: 0.5,
      memory: 2,
      restartPolicy: "ON_FAILURE",
      restartRetries: 0,
      startCommand: "redis-server --appendonly yes",
    });
  });

  it("accepts both ends of each range and refuses just past the top", () => {
    expect(parse({ replicas: "1" }).success).toBe(true);
    expect(parse({ replicas: String(LIMITS.REPLICAS_MAX) }).success).toBe(true);
    expect(messageOf({ replicas: String(LIMITS.REPLICAS_MAX + 1) })).toBe(
      "validation.replicasTooMany",
    );
    expect(parse({ cpu: String(LIMITS.VCPU_MAX) }).success).toBe(true);
    expect(messageOf({ cpu: String(LIMITS.VCPU_MAX + 1) })).toBe(
      "validation.cpuTooLarge",
    );
    expect(parse({ memory: String(LIMITS.MEMORY_GB_MAX) }).success).toBe(true);
    expect(messageOf({ memory: String(LIMITS.MEMORY_GB_MAX + 1) })).toBe(
      "validation.memoryTooLarge",
    );
    expect(parse({ restartRetries: String(LIMITS.RESTART_RETRIES_MAX) }).success).toBe(
      true,
    );
    expect(messageOf({ restartRetries: String(LIMITS.RESTART_RETRIES_MAX + 1) })).toBe(
      "validation.restartRetriesTooMany",
    );
  });

  /*
   * The floors, which differ on purpose and are the pair an obvious tidy-up collapses.
   * "Retry zero times" is a thing someone means; "run zero replicas" is not a smaller
   * service, it is a refused mutation.
   */
  it("allows zero retries and refuses zero replicas", () => {
    expect(
      parse({ restartPolicy: "ON_FAILURE", restartRetries: "0" }).data?.restartRetries,
    ).toBe(0);
    expect(messageOf({ replicas: "0" })).toBe("validation.replicasInvalid");
  });

  it("refuses a CPU or memory request of zero, which is not a smaller service", () => {
    expect(messageOf({ cpu: "0" })).toBe("validation.cpuInvalid");
    expect(messageOf({ memory: "0" })).toBe("validation.memoryInvalid");
  });

  /*
   * Every entry is a value one of the obvious implementations would have taken: parseInt
   * reads "3abc" as 3, and Number reads "0x3" and "1e1" as 3 and 10. The same argument the
   * port rule above makes, and the counts are stricter than the amounts by one character —
   * a decimal point is a real request for CPU and nonsense for a replica count.
   */
  it("refuses anything that is not plainly a decimal number", () => {
    for (const bad of ["3abc", "3 0", "three", "3.5", "-3", "0x3", "1e1", "+3"]) {
      expect(messageOf({ replicas: bad }), bad).toBe("validation.replicasInvalid");
    }
    for (const bad of ["1abc", "1 0", "one", "-1", "0x1", "1e1", "+1", "1.2.3"]) {
      expect(messageOf({ cpu: bad }), bad).toBe("validation.cpuInvalid");
    }
  });

  it("takes a decimal CPU request, which is what Railway prices", () => {
    expect(parse({ cpu: "0.25" }).data?.cpu).toBe(0.25);
    expect(parse({ memory: "0.5" }).data?.memory).toBe(0.5);
  });

  it("accepts the three restart policies Railway offers and nothing else", () => {
    for (const policy of ["ALWAYS", "NEVER", "ON_FAILURE"]) {
      expect(parse({ restartPolicy: policy }).data?.restartPolicy, policy).toBe(policy);
    }
    // Case-sensitive: the value is a GraphQL enum member, not a word.
    expect(messageOf({ restartPolicy: "always" })).toBe(
      "validation.restartPolicyInvalid",
    );
    expect(messageOf({ restartPolicy: "SOMETIMES" })).toBe(
      "validation.restartPolicyInvalid",
    );
  });

  it("bounds a region by charset and length rather than by membership", () => {
    expect(parse({ region: "us-west2" }).success).toBe(true);
    expect(parse({ region: "europe-west4-drams3a" }).success).toBe(true);
    // Not a region Railway issues, and accepted: this rule refuses shapes, and Railway is
    // the thing that decides whether a code exists. See SECURITY.md, "Input surfaces".
    expect(parse({ region: "atlantis-1" }).success).toBe(true);
    for (const bad of [
      "US_WEST",
      "us west",
      "../etc",
      "us.west",
      "a".repeat(LIMITS.REGION_MAX + 1),
    ]) {
      expect(messageOf({ region: bad }), bad).toBe("validation.regionInvalid");
    }
  });

  it("bounds the start command and refuses a line break in it", () => {
    expect(parse({ startCommand: "x".repeat(LIMITS.START_COMMAND_MAX) }).success).toBe(
      true,
    );
    expect(messageOf({ startCommand: "x".repeat(LIMITS.START_COMMAND_MAX + 1) })).toBe(
      "validation.startCommandTooLong",
    );
    expect(messageOf({ startCommand: "redis-server\nrm -rf /" })).toBe(
      "validation.startCommandInvalid",
    );
  });

  it("trims, so a stray space is neither a value nor an error", () => {
    expect(parse({ replicas: "  2  " }).data?.replicas).toBe(2);
    expect(parse({ startCommand: "  serve  " }).data?.startCommand).toBe("serve");
    expect(parse({ replicas: "   " }).data?.replicas).toBeUndefined();
  });

  /*
   * Declaration order is error priority, and these two cases are the contract: the action
   * reports issues[0], so a field on screen has to outrank one behind a closed disclosure,
   * and both have to outrank a form that arrived without its key.
   */
  it("reports a visible field ahead of an advanced one", () => {
    expect(messageOf({ name: "", replicas: "999" })).toBe("validation.nameRequired");
  });

  it("reports an advanced field ahead of a missing submission key", () => {
    expect(messageOf({ replicas: "999", idempotencyKey: "" })).toBe(
      "validation.replicasTooMany",
    );
  });

  it("attributes each failure to its own field, so it renders inline", () => {
    expect(parse({ replicas: "0" }).error?.issues[0]?.path[0]).toBe("replicas");
    expect(parse({ cpu: "0" }).error?.issues[0]?.path[0]).toBe("cpu");
    expect(parse({ memory: "0" }).error?.issues[0]?.path[0]).toBe("memory");
    expect(parse({ startCommand: "a\nb" }).error?.issues[0]?.path[0]).toBe(
      "startCommand",
    );
  });

  /*
   * The guard on the object these fields are NOT in. `containerFields` is shared with the
   * edit schema, and an edit form carrying these would post seven blanks for a service that
   * is already running — which reads as "unset the region, unset the replica count" against
   * values somebody chose. An edit path can carry them once it reads the current ones back
   * off ServiceInstance first.
   */
  it("is absent from the edit schema, which would otherwise reset a running service", () => {
    const edited = containerEditSchema.safeParse({
      projectId: "p1",
      environmentId: "e1",
      serviceId: "s1",
      name: "cache",
      image: "redis:7",
      region: "us-west2",
      replicas: "3",
    });
    expect(edited.success).toBe(true);
    expect(edited.data).not.toHaveProperty("region");
    expect(edited.data).not.toHaveProperty("replicas");
  });

  it("names catalog keys the action can resolve, with their bounds", () => {
    for (const key of [
      "validation.regionInvalid",
      "validation.replicasInvalid",
      "validation.replicasTooMany",
      "validation.cpuInvalid",
      "validation.cpuTooLarge",
      "validation.memoryInvalid",
      "validation.memoryTooLarge",
      "validation.restartPolicyInvalid",
      "validation.restartRetriesInvalid",
      "validation.restartRetriesTooMany",
      "validation.startCommandInvalid",
      "validation.startCommandTooLong",
    ]) {
      expect(VALIDATION_KEYS.has(key), key).toBe(true);
    }
    expect(VALIDATION_VALUES["validation.replicasTooMany"]).toEqual({
      max: LIMITS.REPLICAS_MAX,
    });
    expect(VALIDATION_VALUES["validation.cpuTooLarge"]).toEqual({
      max: LIMITS.VCPU_MAX,
    });
    expect(VALIDATION_VALUES["validation.memoryTooLarge"]).toEqual({
      max: LIMITS.MEMORY_GB_MAX,
    });
    expect(catalog.validation.replicasTooMany).toContain("{max");
    expect(catalog.validation.startCommandTooLong).toContain("{max");
  });
});
