import { readFileSync } from "node:fs";
import { buildSchema, Kind, parse, validate } from "graphql";
import { describe, expect, it } from "vitest";
import { operationNameOf as derivedOperationName } from "./client";
import { DOCUMENTS, type NamedDocument } from "./documents";
import { DEGRADING_OPERATIONS, OPTIONAL_FIELDS } from "./schema-policy";
import { SCHEMA_PATH } from "./schema-path";

/**
 * Every document the app sends, validated against the committed schema.
 *
 * `pnpm codegen` already refuses to generate types for a document that does not validate,
 * and this is here because that is a gate on a *generation step* rather than on the code.
 * A document edited without regenerating, a schema artifact refreshed while a selection went
 * stale, or a fragment that stopped being interpolated all fail here — in the tier that runs
 * on every commit, with the failure named against the operation rather than against a task.
 *
 * The documents are validated one at a time, deliberately. Each string is the exact text
 * that goes on the wire, and the three that select `...ProjectFields` carry the fragment's
 * own text inside them — merged into one set, that fragment would be declared three times
 * and nothing would validate.
 */
const schema = buildSchema(readFileSync(SCHEMA_PATH, "utf8"));

/** The operation name Railway knows a document by, read off its AST. */
const operationNameOf = (document: NamedDocument): string => {
  const operation = parse(document.document).definitions.find(
    (definition) => definition.kind === Kind.OPERATION_DEFINITION,
  );
  return operation?.name?.value ?? "";
};

describe("the GraphQL documents", () => {
  it("are named the same by the client's regex and by a real parse", () => {
    /*
     * `client.ts` labels every log record and every RailwayApiError with a name it reads
     * off the document with a regex, because parsing the document on each request to learn
     * something fixed would be absurd. This is what makes the shortcut safe: the regex has
     * to agree with graphql's own parser on all twenty-eight, or the label is wrong.
     *
     * It matters more than a label. `DEGRADING_OPERATIONS` is keyed by operation name, and
     * `scripts/verify-schema.ts` looks it up using the parsed name — so a document the
     * regex reads differently would silently stop being recognised as one whose failure the
     * app survives, and the schema job would start failing on it.
     *
     * The name used to be written a second time at each of the twenty-six call sites in
     * api.ts. This assertion is what replaced those literals.
     */
    for (const document of DOCUMENTS) {
      expect(
        derivedOperationName(document.document),
        `${document.export} is read differently by the regex than by the parser`,
      ).toBe(operationNameOf(document));
    }
  });

  it("finds every document in operations.ts", () => {
    /*
     * A count and a list, because DOCUMENTS is derived from the module's string exports —
     * which is what makes it correct and also what makes it silent. A document added without
     * an export, or an export that stopped being a string and quietly left the set, is
     * invisible everywhere else.
     */
    expect(DOCUMENTS).toHaveLength(31);
    expect(DOCUMENTS.map(operationNameOf).toSorted()).toEqual([
      "BuildLogs",
      "Deployment",
      "DeploymentEvents",
      "DeploymentLogs",
      "DeploymentRestart",
      "DeploymentRollback",
      "DeploymentStop",
      "Deployments",
      "EnvironmentCreate",
      "EnvironmentVolumes",
      "Project",
      "ProjectCreate",
      "ProjectMetrics",
      "ProjectsPersonal",
      "ProjectsWorkspace",
      "Regions",
      "ServiceCreate",
      "ServiceDelete",
      "ServiceDomainCreate",
      "ServiceInstance",
      "ServiceInstanceDeployV2",
      "ServiceInstanceLimitsUpdate",
      "ServiceInstanceUpdate",
      "ServiceUpdate",
      "ServiceVariables",
      "StreamBuildLogs",
      "StreamDeploymentLogs",
      "VariableCollectionUpsert",
      "VariableDelete",
      "VolumeCreate",
      "VolumeDelete",
    ]);
  });

  it.each(DOCUMENTS)("$export validates against the committed schema", (document) => {
    const errors = validate(schema, parse(document.document));
    expect(errors.map((error) => error.message)).toEqual([]);
  });

  it("only exempts documents that exist", () => {
    // DEGRADING_OPERATIONS is what stops verify:schema failing over a refused metrics or
    // deploymentEvents read. An entry naming an operation nobody sends would silently
    // exempt nothing at all.
    const names = DOCUMENTS.map(operationNameOf);
    for (const entry of DEGRADING_OPERATIONS) {
      expect(names).toContain(entry.operationName);
    }
  });

  it("keeps the capability probe to things no document sends", () => {
    /*
     * The other half of that split. OPTIONAL_FIELDS exists for capabilities the app has not
     * built, and the moment a document starts selecting one it becomes a dependency —
     * verified by the documents, and reported by a probe that would then be claiming the app
     * can live without something it sends on every render.
     */
    const text = DOCUMENTS.map((document) => document.document).join("\n");
    for (const optional of OPTIONAL_FIELDS) {
      expect(text).not.toContain(`${optional.field}(`);
    }
  });
});
