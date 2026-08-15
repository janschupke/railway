/**
 * Does the app still match Railway's API?
 *
 * Railway publishes no schema artifact, so `pnpm schema:pull` dumps one from live
 * introspection into src/lib/railway/schema.graphql, `pnpm codegen` generates the documents'
 * types from it, and this script is what says whether that committed copy is still true.
 *
 *   pnpm verify:schema                      # OIDC discovery + documents vs the committed schema
 *   RAILWAY_TOKEN=… pnpm verify:schema      # + documents vs the LIVE schema, and the drift
 *
 * Exits non-zero if anything the app *requires* is missing.
 *
 * What replaced the hand-maintained lists. This script used to check a list of root fields,
 * input objects and enum members restated in operations.ts by hand — which could only ever
 * name *root* fields, and which said nothing about the nested selections underneath them.
 * Now the real documents are validated against the real schema, so a renamed field two types
 * down is a validation error like any other, and there is no list to keep up to date. The
 * two things that cannot be derived are still declared there: DEGRADING_OPERATIONS, because
 * "this document may fail and the app still works" is a product decision, and OPTIONAL_FIELDS,
 * because no document mentions a capability the app has not built yet.
 */

import { readFileSync } from "node:fs";
import {
  buildClientSchema,
  buildSchema,
  getIntrospectionQuery,
  isEnumType,
  isInputObjectType,
  isObjectType,
  Kind,
  parse,
  TypeInfo,
  validate,
  visit,
  visitWithTypeInfo,
  type DocumentNode,
  type GraphQLNamedType,
  type GraphQLSchema,
  type IntrospectionQuery,
} from "graphql";
import { DOCUMENTS } from "../src/lib/railway/documents.ts";
import {
  DEGRADING_OPERATIONS,
  OPTIONAL_FIELDS,
  PROBED_INPUT_TYPES,
} from "../src/lib/railway/operations.ts";
import { SCHEMA_PATH } from "../src/lib/railway/schema-path.ts";
import { railwayMetadata } from "../src/lib/auth/oidc-metadata.ts";
import { RAILWAY_DEFAULTS } from "../src/env.ts";

const ENDPOINT = RAILWAY_DEFAULTS.API_URL;
const ISSUER = RAILWAY_DEFAULTS.ISSUER;
const DISCOVERY = `${ISSUER}/oauth/.well-known/openid-configuration`;

/*
 * Derived from the app's own metadata rather than restated, so the two cannot drift.
 * They did once: the pinned shape omitted `id_token_signing_alg_values_supported`,
 * oauth4webapi fell back to demanding RS256, and every real sign-in failed while this
 * script — which only compared endpoint URLs — reported all clear.
 */
const METADATA = railwayMetadata(ISSUER) as Record<string, unknown>;

const PINNED_URLS = [
  "issuer",
  "authorization_endpoint",
  "token_endpoint",
  "userinfo_endpoint",
  "jwks_uri",
] as const;

/** Pinned lists that must match the live document exactly, in any order. */
const PINNED_LISTS = ["id_token_signing_alg_values_supported"] as const;

/** Pinned lists where the app only depends on one entry still being offered. */
const REQUIRED_MEMBERS: Record<string, string> = {
  token_endpoint_auth_methods_supported: "client_secret_basic",
};

/**
 * Endpoints Railway does not offer, asserted rather than assumed.
 *
 * There is no `revocation_endpoint` and no `end_session_endpoint` in the live document,
 * and the paths a provider of this shape would put them on — `/oauth/token/revocation`,
 * `/oauth/revoke`, `/oauth/revocation`, `/oauth/session/end`, `/oauth/logout` — all
 * answer 404 to a POST that `/oauth/token` answers with `invalid_request`. So the
 * omission is a configuration choice and not an incomplete document, and sign-out is
 * local because nothing else is reachable, not because this app declined to call it.
 * See the Limitations entry and the accepted risk in SECURITY.md.
 *
 * Checked here because the whole limitation rests on it. The day either appears, the
 * README is wrong, the sign-out notice is wrong, and there is a real feature to build —
 * a red line on every push is how anyone finds that out.
 */
const ABSENT_ENDPOINTS = ["revocation_endpoint", "end_session_endpoint"] as const;

/**
 * The subscriptions the app opens. Missing one is a broken log pane.
 *
 * Both are reached through `streamLogs`, not through a document validated above — the two
 * `Stream*Logs` documents are in DOCUMENTS and are checked there — so this is the field
 * list rather than a second validation. It is here because the pair below needs a home and
 * a list of what Railway offers is worth having in one place.
 */
const EXPECTED_SUBSCRIPTIONS = ["buildLogs", "deploymentLogs"] as const;

/**
 * Subscriptions whose absence an architectural decision rests on.
 *
 * ADR-3 and ADR-10 argue that the dashboard has to poll because Railway publishes nothing
 * to subscribe to at the project or service level. That is true, and it is the whole reason
 * `/api/watch` exists and costs a Railway request every WATCH_POLL_MS. The day either
 * appears, the watcher is the wrong design and two ADRs are stale.
 *
 * ADR-10 already claimed this was checked — "pnpm verify:schema introspects the live API and
 * would say otherwise if that changed". It was not: this file contained no reference to
 * `Subscription` at all, so the guard would never have fired. This is that guard, built to
 * match the claim, and deliberately narrower than the claim was: it names the two levels the
 * argument actually depends on rather than asserting that no deployment subscription exists,
 * because one does. `checkSubscriptions` prints that one instead.
 */
const ABSENT_SUBSCRIPTIONS = ["project", "service"] as const;

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

const ok = (s: string) => `\x1b[32m✓\x1b[0m ${s}`;
const bad = (s: string) => `\x1b[31m✗\x1b[0m ${s}`;
const warn = (s: string) => `\x1b[33m!\x1b[0m ${s}`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

let failed = false;

/** A document, parsed once, with the operation name Railway knows it by. */
type ParsedDocument = { operationName: string; export: string; ast: DocumentNode };

function parseDocuments(): ParsedDocument[] {
  return DOCUMENTS.map((document) => {
    // A parse failure here is a broken document, not a schema question — it throws, and
    // main()'s catch reports it as a crash rather than as drift.
    const ast = parse(document.document);
    const operation = ast.definitions.find(
      (definition) => definition.kind === Kind.OPERATION_DEFINITION,
    );
    return {
      // Read off the AST rather than the text: this is the name Railway reports errors
      // against, and `operations.ts` passes the same one as `operationName` on the wire.
      operationName: operation?.name?.value ?? document.export,
      export: document.export,
      ast,
    };
  });
}

const degrades = (operationName: string) =>
  DEGRADING_OPERATIONS.find((entry) => entry.operationName === operationName);

async function checkDiscovery() {
  console.log("\nOIDC discovery");
  const response = await fetch(DISCOVERY);
  if (!response.ok) {
    console.log(bad(`discovery document returned ${response.status}`));
    failed = true;
    return;
  }
  const doc = (await response.json()) as Record<string, unknown>;

  for (const key of PINNED_URLS) {
    const expected = METADATA[key];
    const actual = doc[key];
    if (actual === expected) {
      console.log(ok(key));
    } else {
      console.log(bad(`${key}: pinned ${String(expected)}, live ${String(actual)}`));
      failed = true;
    }
  }

  for (const key of PINNED_LISTS) {
    const expected = (METADATA[key] as string[] | undefined) ?? [];
    const actual = (doc[key] as string[] | undefined) ?? [];
    if (sameSet(expected, actual)) {
      console.log(ok(`${key} [${actual.join(", ")}]`));
    } else {
      console.log(
        bad(`${key}: pinned [${expected.join(", ")}], live [${actual.join(", ")}]`),
      );
      failed = true;
    }
  }

  for (const [key, member] of Object.entries(REQUIRED_MEMBERS)) {
    const actual = (doc[key] as string[] | undefined) ?? [];
    if (actual.includes(member)) {
      console.log(ok(`${key} still offers ${member}`));
    } else {
      console.log(
        bad(`${key} no longer offers ${member}: live [${actual.join(", ")}]`),
      );
      failed = true;
    }
  }

  for (const key of ABSENT_ENDPOINTS) {
    const actual = doc[key];
    if (actual === undefined) {
      console.log(ok(`${key} still absent`));
    } else {
      // The URL, not just the fact: whoever reads this line is about to write the call.
      console.log(
        bad(`${key} now offered at ${String(actual)} — sign-out can end the grant`),
      );
      failed = true;
    }
  }

  const scopes = (doc.scopes_supported as string[] | undefined) ?? [];
  // workspace:viewer belongs here as much as project:admin: Railway scopes workspaces
  // separately, and without it `me.workspaces` is refused rather than merely empty.
  const needed = ["openid", "offline_access", "project:admin", "workspace:viewer"];
  for (const scope of needed) {
    if (scopes.includes(scope)) console.log(ok(`scope ${scope}`));
    else {
      console.log(bad(`scope ${scope} is not advertised`));
      failed = true;
    }
  }
}

/**
 * Every document, validated against one schema.
 *
 * This is the whole verification, and it reaches everything the old field list could not:
 * a nested field, an argument name, an enum value written into a document, the type of a
 * variable. A document in DEGRADING_OPERATIONS reports and does not fail — see the note on
 * that constant for why the two exceptions exist and why the exemption being per document
 * costs nothing.
 */
/**
 * What Railway lets a client subscribe to, and what this app does with it.
 *
 * Runs against the committed schema so it gates in CI, which holds no token. That is the
 * same reasoning `checkDocuments` gives for its tokenless half, and it is the difference
 * between a guard and an intention: a check that only runs on a developer's machine with a
 * credential is a check nobody runs.
 *
 * The third section is the one that would have caught the drift this was written for.
 * Asserting an absence only reports fields nobody thought about; printing what exists and
 * goes unused puts `deployment` — "Subscribe to updates for a specific deployment", which
 * carries `status` — in front of whoever runs this, next to the note saying the app polls
 * instead. Three ADRs and a constant said that field did not exist.
 */
function checkSubscriptions(schema: GraphQLSchema) {
  console.log("\nSubscriptions");

  const subscription = schema.getSubscriptionType();
  if (!subscription) {
    console.log(bad("the schema declares no Subscription type at all"));
    failed = true;
    return;
  }

  const fields = subscription.getFields();

  for (const name of EXPECTED_SUBSCRIPTIONS) {
    if (fields[name]) {
      console.log(ok(`${name} — the log stream depends on it`));
    } else {
      console.log(bad(`${name} is gone; the log pane has nothing to open`));
      failed = true;
    }
  }

  for (const name of ABSENT_SUBSCRIPTIONS) {
    if (!fields[name]) {
      console.log(
        ok(`no ${name} subscription — ADR-10's watcher is still the only way`),
      );
    } else {
      console.log(
        bad(
          `${name} is now subscribable — /api/watch polls for a reason that no longer holds (ADR-3, ADR-10)`,
        ),
      );
      failed = true;
    }
  }

  const unused = Object.keys(fields)
    .filter((name) => !EXPECTED_SUBSCRIPTIONS.includes(name as never))
    .sort();

  if (unused.length > 0) {
    console.log(dim(`  available and unused: ${unused.join(", ")}`));
    console.log(
      dim("  deployment/deploymentEvents exist; ADR-3 records why status is polled."),
    );
  }
}

function checkDocuments(
  schema: GraphQLSchema,
  documents: ParsedDocument[],
  against: string,
) {
  console.log(`\nDocuments vs ${against}`);

  for (const document of documents) {
    const errors = validate(schema, document.ast);
    if (errors.length === 0) {
      console.log(ok(document.operationName));
      continue;
    }

    const degrading = degrades(document.operationName);
    for (const error of errors) {
      const label = `${document.operationName}: ${error.message}`;
      if (degrading) {
        console.log(warn(`${label} — ${degrading.note}`));
      } else {
        console.log(bad(label));
        failed = true;
      }
    }
  }
}

/**
 * The part of a schema the documents actually reach.
 *
 * Collected by walking each document with the type information the committed schema gives
 * it, so it is derived from the app's selections rather than declared: every field selected,
 * every input object a variable carries (and every input object inside those), and every
 * enum either of them names.
 *
 * Field and input members are recorded with their *printed type* — `String!`, `[Log!]!` —
 * because a field that still exists with a different type is the drift the generated types
 * would go on misclaiming. That is the class of change document validation cannot see: a
 * field going from `String!` to `String` validates perfectly and makes every non-null
 * assertion downstream a lie.
 */
type Surface = {
  /** "Project.name" → "String!" */
  fields: Map<string, string>;
  /** "ServiceCreateInput.source" → "ServiceSourceInput" */
  inputFields: Map<string, string>;
  /** Enum type name → its members, as the committed schema has them. */
  enums: Map<string, string[]>;
  /** Selected fields Railway has marked deprecated, with the reason it gave. */
  deprecations: string[];
};

function collectSurface(schema: GraphQLSchema, documents: ParsedDocument[]): Surface {
  const surface: Surface = {
    fields: new Map(),
    inputFields: new Map(),
    enums: new Map(),
    deprecations: [],
  };

  /** An input object or enum a variable carries, plus everything nested inside it. */
  const collectInput = (type: GraphQLNamedType, seen: Set<string>) => {
    if (seen.has(type.name)) return;
    seen.add(type.name);

    if (isEnumType(type)) {
      surface.enums.set(
        type.name,
        type.getValues().map((value) => value.name),
      );
      return;
    }
    if (!isInputObjectType(type)) return;

    for (const field of Object.values(type.getFields())) {
      surface.inputFields.set(`${type.name}.${field.name}`, String(field.type));
      const named = namedTypeOf(field.type);
      const resolved = schema.getType(named);
      if (resolved) collectInput(resolved, seen);
    }
  };

  for (const document of documents) {
    const typeInfo = new TypeInfo(schema);
    visit(
      document.ast,
      visitWithTypeInfo(typeInfo, {
        Field() {
          const parent = typeInfo.getParentType();
          const field = typeInfo.getFieldDef();
          if (!parent || !field) return;

          surface.fields.set(`${parent.name}.${field.name}`, String(field.type));

          if (field.deprecationReason) {
            surface.deprecations.push(
              `${parent.name}.${field.name} — ${field.deprecationReason}`,
            );
          }

          const named = schema.getType(namedTypeOf(field.type));
          // An enum a *field* returns, so a member Railway withdraws from
          // DeploymentStatus is visible here too and not only through the variables.
          if (named && isEnumType(named)) {
            surface.enums.set(
              named.name,
              named.getValues().map((value) => value.name),
            );
          }
        },
        VariableDefinition() {
          const type = typeInfo.getInputType();
          if (!type) return;
          const resolved = schema.getType(namedTypeOf(type));
          if (resolved) collectInput(resolved, new Set());
        },
      }),
    );
  }

  return surface;
}

/** `[Log!]!` → `Log`. */
function namedTypeOf(type: { toString: () => string }): string {
  return String(type).replaceAll(/[[\]!]/g, "");
}

/**
 * Fields the app selects that Railway has marked deprecated.
 *
 * Printed, never gating: a deprecation is an announcement, not a withdrawal, and the app
 * keeps working until the field goes. It earns its place because two of them are live right
 * now and both sit on reads this app cannot do without — see README's Limitations.
 */
function reportDeprecations(deprecations: string[]) {
  if (deprecations.length === 0) return;
  console.log("\nDeprecated fields the app selects");
  for (const entry of [...new Set(deprecations)].sort()) console.log(warn(entry));
}

/**
 * The committed schema against the live one, over the surface the documents reach.
 *
 * Deliberately not a whole-schema diff. Railway ships changes to this API constantly and
 * almost none of them are about the sixteen documents in operations.ts; a report that listed
 * all of them would be a report nobody reads. A change to a field the app selects is a
 * different thing, and it fails.
 */
function checkDrift(committed: Surface, live: GraphQLSchema) {
  console.log("\nCommitted schema vs live");
  let drifted = 0;

  for (const [key, committedType] of committed.fields) {
    const [typeName = "", fieldName = ""] = key.split(".");
    const parent = live.getType(typeName);
    if (!parent || !isObjectType(parent)) {
      console.log(bad(`${typeName} is gone from the live schema (selected as ${key})`));
      failed = true;
      drifted++;
      continue;
    }
    const field = parent.getFields()[fieldName];
    if (!field) {
      console.log(bad(`${key} is gone from the live schema`));
      failed = true;
      drifted++;
      continue;
    }
    if (String(field.type) !== committedType) {
      console.log(
        bad(`${key}: committed ${committedType}, live ${String(field.type)}`),
      );
      failed = true;
      drifted++;
    }
  }

  for (const [key, committedType] of committed.inputFields) {
    const [typeName = "", fieldName = ""] = key.split(".");
    const parent = live.getType(typeName);
    if (!parent || !isInputObjectType(parent)) {
      console.log(
        bad(`${typeName} is gone from the live schema (a variable sends it)`),
      );
      failed = true;
      drifted++;
      continue;
    }
    const field = parent.getFields()[fieldName];
    if (!field) {
      console.log(bad(`${key} is gone from the live schema`));
      failed = true;
      drifted++;
      continue;
    }
    if (String(field.type) !== committedType) {
      // Covers a member becoming required, which no document can show: the app builds
      // these objects in TypeScript, so the only place `String` → `String!` is visible is
      // right here and in the types the next `pnpm codegen` would generate.
      console.log(
        bad(`${key}: committed ${committedType}, live ${String(field.type)}`),
      );
      failed = true;
      drifted++;
    }
  }

  /*
   * Enum members are reported, not gated, and the asymmetry is deliberate. A member the app
   * writes into a document is already covered — validation against live fails on it — and a
   * member it only reads back degrades by design: `toContainerState` maps an unknown
   * DeploymentStatus to "unknown" precisely because Railway adds these without notice.
   */
  for (const [name, members] of committed.enums) {
    const type = live.getType(name);
    if (!type || !isEnumType(type)) {
      console.log(bad(`enum ${name} is gone from the live schema`));
      failed = true;
      drifted++;
      continue;
    }
    const liveMembers = type.getValues().map((value) => value.name);
    const removed = members.filter((member) => !liveMembers.includes(member));
    const added = liveMembers.filter((member) => !members.includes(member));
    if (removed.length)
      console.log(warn(`${name} no longer offers: ${removed.join(", ")}`));
    if (added.length) console.log(dim(`  ${name} also offers: ${added.join(", ")}`));
  }

  if (drifted === 0) {
    console.log(
      ok(
        `${committed.fields.size} selected fields and ${committed.inputFields.size} input members match`,
      ),
    );
  } else {
    console.log(warn("Run `pnpm schema:pull && pnpm codegen` to take the change on."));
  }
}

/**
 * Capabilities Railway does not document and this app does not use.
 *
 * The one part of this script that is still a hand-written list, because it has to be: no
 * document mentions a mutation nobody calls. See OPTIONAL_FIELDS.
 */
function checkOptional(live: GraphQLSchema) {
  console.log("\nOptional capabilities");
  const roots: Record<string, GraphQLNamedType | null | undefined> = {
    Query: live.getQueryType(),
    Mutation: live.getMutationType(),
  };

  for (const optional of OPTIONAL_FIELDS) {
    const root = roots[optional.root];
    const field =
      root && isObjectType(root) ? root.getFields()[optional.field] : undefined;
    const label = `${optional.root}.${optional.field}`;
    if (field) {
      const args =
        field.args.map((arg) => `${arg.name}: ${String(arg.type)}`).join(", ") ||
        "none";
      console.log(ok(`${label} available (${args})`));
    } else {
      // The consequence, per field. This used to print one hardcoded sentence for all
      // of them, which was already the wrong sentence for two of the three.
      console.log(warn(`${label} not available — ${optional.note}`));
    }
  }

  // Printed, never enforced. These are the shapes a feature is being designed against,
  // and guessing at a mutation's input is how you find out in production.
  console.log("\nProbed input shapes");
  for (const name of PROBED_INPUT_TYPES) {
    const type = live.getType(name);
    if (!type || !isInputObjectType(type)) {
      console.log(warn(`${name} not available`));
      continue;
    }
    const fields = Object.values(type.getFields())
      .map((field) => `${field.name}: ${String(field.type)}`)
      .join(", ");
    console.log(ok(`${name} { ${fields} }`));
  }
}

async function introspect(token: string): Promise<GraphQLSchema | null> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query: getIntrospectionQuery({ descriptions: true }) }),
  });

  const body = (await response.json()) as {
    data?: IntrospectionQuery;
    errors?: Array<{ message: string }>;
  };

  const [error] = body.errors ?? [];
  if (error) {
    console.log(bad(`introspection rejected: ${error.message}`));
    console.log(
      warn("If introspection is disabled, verify operations by running them instead."),
    );
    failed = true;
    return null;
  }
  if (!body.data) {
    console.log(bad(`introspection returned no data (HTTP ${response.status})`));
    failed = true;
    return null;
  }

  return buildClientSchema(body.data);
}

async function main() {
  const token = process.env.RAILWAY_TOKEN;
  const documents = parseDocuments();
  const committed = buildSchema(readFileSync(SCHEMA_PATH, "utf8"));

  await checkDiscovery();

  /*
   * The half that needs no credential, which is new and is the reason CI gains something
   * from this file beyond the discovery check. It catches a document edited without
   * regenerating — the same failure `pnpm codegen` catches, in the job that has no token.
   */
  checkDocuments(committed, documents, "the committed schema");
  checkSubscriptions(committed);
  const surface = collectSurface(committed, documents);
  reportDeprecations(surface.deprecations);

  if (!token) {
    console.log(`\n${warn("RAILWAY_TOKEN not set — skipped the live API.")}`);
    console.log("  Create one at https://railway.com/account/tokens, then re-run:");
    console.log("  RAILWAY_TOKEN=… pnpm verify:schema\n");
    process.exit(failed ? 1 : 0);
  }

  const live = await introspect(token);
  if (live) {
    checkDocuments(live, documents, "the live API");
    checkDrift(surface, live);
    checkOptional(live);
  }

  console.log(
    failed
      ? `\n${bad("Verification failed — the app's operations do not match the live API.")}\n`
      : `\n${ok("All required operations verified against the live API.")}\n`,
  );
  process.exit(failed ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error(bad(`verification crashed: ${String(error)}`));
  process.exit(1);
});
