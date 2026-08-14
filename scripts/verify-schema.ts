/**
 * Phase 0 verification.
 *
 * Railway publishes no schema artifact, and their API guides omit several things this
 * app depends on. Rather than assume, this script introspects the live API and checks
 * every root field the app sends, plus re-fetches the OIDC discovery document and
 * diffs it against the metadata pinned in src/lib/auth/oidc-metadata.ts.
 *
 *   RAILWAY_TOKEN=<account or workspace token> pnpm verify:schema
 *
 * Exits non-zero if anything the app *requires* is missing.
 */

import {
  OPTIONAL_FIELDS,
  PROBED_INPUT_TYPES,
  REQUIRED_ENUM_MEMBERS,
  REQUIRED_FIELDS,
  REQUIRED_INPUT_TYPES,
} from "../src/lib/railway/operations.ts";
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

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

/*
 * Arg *types* as well as names. A field that still exists but now takes a different input
 * object is a passing check and a failing app, and reading the type is the difference
 * between "serviceCreate exists" and "serviceCreate takes the thing we are sending".
 */
const INTROSPECTION = `
  query VerifyRootFields {
    __schema {
      queryType { fields { name args { name ...ArgType } } }
      mutationType { fields { name args { name ...ArgType } } }
      subscriptionType { fields { name args { name ...ArgType } } }
    }
  }
  fragment ArgType on __InputValue {
    type { kind name ofType { kind name ofType { kind name } } }
  }
`;

const INPUT_TYPE_INTROSPECTION = `
  query VerifyInputType($name: String!) {
    __type(name: $name) {
      name
      inputFields { name type { kind name ofType { kind name } } }
    }
  }
`;

const ENUM_INTROSPECTION = `
  query VerifyEnum($name: String!) {
    __type(name: $name) { name enumValues { name } }
  }
`;

type TypeRef = {
  kind: string;
  name: string | null;
  ofType?: TypeRef | null;
} | null;

/** `NON_NULL(LIST(String))` → `[String]!`, close enough to read at a glance. */
function typeName(type: TypeRef): string {
  if (!type) return "?";
  if (type.kind === "NON_NULL") return `${typeName(type.ofType ?? null)}!`;
  if (type.kind === "LIST") return `[${typeName(type.ofType ?? null)}]`;
  return type.name ?? "?";
}

type Field = { name: string; args: Array<{ name: string; type?: TypeRef }> };
type Introspection = {
  __schema: {
    queryType: { fields: Field[] } | null;
    mutationType: { fields: Field[] } | null;
    subscriptionType: { fields: Field[] } | null;
  };
};

const ok = (s: string) => `\x1b[32m✓\x1b[0m ${s}`;
const bad = (s: string) => `\x1b[31m✗\x1b[0m ${s}`;
const warn = (s: string) => `\x1b[33m!\x1b[0m ${s}`;

let failed = false;

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

async function checkSchema(token: string) {
  console.log("\nGraphQL schema");
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query: INTROSPECTION }),
  });

  const body = (await response.json()) as {
    data?: Introspection;
    errors?: Array<{ message: string }>;
  };

  const [introspectionError] = body.errors ?? [];
  if (introspectionError) {
    console.log(bad(`introspection rejected: ${introspectionError.message}`));
    console.log(
      warn("If introspection is disabled, verify operations by running them instead."),
    );
    failed = true;
    return;
  }
  if (!body.data) {
    console.log(bad(`introspection returned no data (HTTP ${response.status})`));
    failed = true;
    return;
  }

  const byRoot: Record<string, Field[]> = {
    Query: body.data.__schema.queryType?.fields ?? [],
    Mutation: body.data.__schema.mutationType?.fields ?? [],
    Subscription: body.data.__schema.subscriptionType?.fields ?? [],
  };

  for (const required of REQUIRED_FIELDS) {
    const field = byRoot[required.root]?.find((f) => f.name === required.field);
    const label = `${required.root}.${required.field}`;

    if (!field) {
      console.log(bad(`${label} does not exist`));
      failed = true;
      continue;
    }

    const argNames = new Set(field.args.map((a) => a.name));
    const missing = required.args.filter((a) => !argNames.has(a));
    if (missing.length) {
      console.log(bad(`${label} exists but is missing args: ${missing.join(", ")}`));
      failed = true;
    } else {
      console.log(ok(label));
    }
  }

  console.log("\nOptional capabilities");
  for (const optional of OPTIONAL_FIELDS) {
    const field = byRoot[optional.root]?.find((f) => f.name === optional.field);
    const label = `${optional.root}.${optional.field}`;
    if (field) {
      const args =
        field.args.map((a) => `${a.name}: ${typeName(a.type ?? null)}`).join(", ") ||
        "none";
      console.log(ok(`${label} available (${args})`));
    } else {
      // The consequence, per field. This used to print one hardcoded sentence for all
      // of them, which was already the wrong sentence for two of the three.
      console.log(warn(`${label} not available — ${optional.note}`));
    }
  }
}

/**
 * Input object shapes.
 *
 * The gap this closes: every check above proves a root *field* exists, and the app also
 * hand-builds the object that field takes. `serviceCreate(input:)` has never been checked
 * beyond its name, so a renamed member inside ServiceCreateInput would pass verification
 * and fail on every real spin-up.
 */
async function checkInputTypes(token: string) {
  console.log("\nInput object shapes");

  const introspect = async (name: string) => {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query: INPUT_TYPE_INTROSPECTION, variables: { name } }),
    });
    const body = (await response.json()) as {
      data?: {
        __type: {
          name: string;
          inputFields: Array<{ name: string; type: TypeRef }> | null;
        } | null;
      };
    };
    return body.data?.__type ?? null;
  };

  for (const required of REQUIRED_INPUT_TYPES) {
    const type = await introspect(required.name);
    if (!type?.inputFields) {
      console.log(bad(`${required.name} does not exist`));
      failed = true;
      continue;
    }
    const present = new Set(type.inputFields.map((f) => f.name));
    const missing = required.fields.filter((f) => !present.has(f));
    if (missing.length) {
      console.log(bad(`${required.name} is missing: ${missing.join(", ")}`));
      failed = true;
    } else {
      console.log(ok(`${required.name} accepts ${required.fields.join(", ")}`));
    }
  }

  // Printed, never enforced. These are the shapes a feature is being designed against,
  // and guessing at a mutation's input is how you find out in production.
  for (const name of PROBED_INPUT_TYPES) {
    const type = await introspect(name);
    if (!type?.inputFields) {
      console.log(warn(`${name} not available`));
      continue;
    }
    const fields = type.inputFields
      .map((f) => `${f.name}: ${typeName(f.type)}`)
      .join(", ");
    console.log(ok(`${name} { ${fields} }`));
  }
}

/**
 * Enum members sent by name.
 *
 * The gap this closes is the one the input-type check closes one type over: every check
 * above proves a *field* exists, and the metrics document also names `CPU_USAGE`,
 * `MEMORY_USAGE_GB` and `SERVICE_ID` literally. A member Railway withdraws does not degrade
 * the readout — it fails the whole document at validation, on every request.
 */
async function checkEnumMembers(token: string) {
  console.log("\nEnum members");

  for (const required of REQUIRED_ENUM_MEMBERS) {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        query: ENUM_INTROSPECTION,
        variables: { name: required.name },
      }),
    });
    const body = (await response.json()) as {
      data?: { __type: { enumValues: Array<{ name: string }> | null } | null };
    };

    const values = body.data?.__type?.enumValues;
    if (!values) {
      console.log(bad(`${required.name} does not exist`));
      failed = true;
      continue;
    }

    const present = new Set(values.map((v) => v.name));
    const missing = required.members.filter((m) => !present.has(m));
    if (missing.length) {
      console.log(bad(`${required.name} is missing: ${missing.join(", ")}`));
      failed = true;
    } else {
      console.log(ok(`${required.name} offers ${required.members.join(", ")}`));
    }
  }
}

async function main() {
  const token = process.env.RAILWAY_TOKEN;

  await checkDiscovery();

  if (!token) {
    console.log(`\n${warn("RAILWAY_TOKEN not set — skipped schema introspection.")}`);
    console.log("  Create one at https://railway.com/account/tokens, then re-run:");
    console.log("  RAILWAY_TOKEN=… pnpm verify:schema\n");
    process.exit(failed ? 1 : 0);
  }

  await checkSchema(token);
  await checkInputTypes(token);
  await checkEnumMembers(token);

  console.log(
    failed
      ? `\n${bad("Verification failed — the app's operations do not match the live API.")}\n`
      : `\n${ok("All required operations verified against the live API.")}\n`,
  );
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(bad(`verification crashed: ${String(error)}`));
  process.exit(1);
});
