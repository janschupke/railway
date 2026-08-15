import type { CodegenConfig } from "@graphql-codegen/cli";

/**
 * Result and variable types for every document in `src/lib/railway/operations.ts`.
 *
 * Generated from the committed schema, never from the network. `pnpm schema:pull` is the
 * only thing that talks to Railway, so `pnpm codegen` and `pnpm typecheck` both run in CI,
 * which holds no RAILWAY_TOKEN — see scripts/pull-schema.ts for why that artifact is in git.
 *
 * The documents are read out of `operations.ts` itself, through the `/* GraphQL *\/` magic
 * comments already on each template literal. There is no second copy of any document: the
 * string the app sends is the string this validates, and the rationale comments stay with
 * the operations they explain.
 */
const config: CodegenConfig = {
  // Stated as a literal rather than imported from src/lib/railway/schema-path.ts: this
  // config is loaded by codegen's own TypeScript loader, which resolves nothing through
  // the app's `@/` alias, and an ESM-only helper here would be a loader problem rather
  // than a config. `operations.test.ts` asserts the two agree.
  /*
   * `assumeValid` because Railway's schema does not pass graphql-js's own schema
   * validation: `Team.id` carries a deprecation its `Node.id` interface field does not,
   * which is an error, not a warning. That is Railway's to fix, and refusing to generate
   * types over it would mean this repository has no typed documents because of a
   * deprecation on a type the app never selects.
   *
   * It weakens nothing this file is for. The documents are still validated against the
   * schema in full — that check is separate, and it is the one that catches drift.
   */
  schema: [{ "src/lib/railway/schema.graphql": { assumeValid: true } }],
  documents: "src/lib/railway/operations.ts",
  // Every document is validated against the schema before anything is written, which is
  // the gate this whole file exists for: a renamed *nested* field fails here, and that is
  // the class of drift `verify-schema.ts` could never see.
  generates: {
    "src/lib/railway/graphql.generated.ts": {
      /*
       * `typescript-operations` alone, without the `typescript` base plugin, which is the
       * one unusual line in this file.
       *
       * With `onlyOperationTypes` this plugin emits everything the documents reach and
       * nothing else — the operation and variable types, plus the nineteen enums and input
       * objects they reference — in 240 lines, self-contained, with scalars inlined rather
       * than routed through a `Scalars` lookup. Adding the base plugin does not add to that:
       * it emits all 609 of Railway's types regardless of `onlyOperationTypes`, and the two
       * outputs then declare the same eight identifiers twice, which does not compile.
       *
       * Rejected: both plugins with no `onlyOperationTypes`. That compiles, and it commits
       * 6000 generated lines describing a container platform in order to type twenty-eight
       * documents — most of it input objects for mutations ADR-6 says this app will never
       * send.
       */
      plugins: ["typescript-operations"],
      config: {
        onlyOperationTypes: true,
        /*
         * Types only, no emitted values: enums become string-literal unions rather than
         * TypeScript `enum` declarations. That keeps this file out of every runtime
         * consideration in the repo — nothing to tree-shake, no coverage to account for,
         * and `import type` at every call site.
         */
        enumsAsTypes: true,
        useTypeImports: true,
        /*
         * Nothing selects __typename. The app dispatches on nothing polymorphic, and a
         * field the documents do not ask for has no business in the result type.
         */
        skipTypename: true,
        /*
         * Fields: a nullable field is `T | null`, present and null, which is what a
         * GraphQL response actually contains. Optional (`field?:`) would let a missing
         * key and a null value read the same, and the mappers branch on null.
         *
         * Input values: left optional, because that is exactly what they are — the app
         * sends four members of ProjectCreateInput's nine, and marking the rest required
         * would break every call site to describe a schema that permits them.
         */
        avoidOptionals: { field: true, inputValue: false },
        /*
         * The scalars the documents actually touch, and `unknown` for the other twenty-two.
         *
         * DateTime is an RFC 3339 string, which is what `createdAt`/`updatedAt` are read as
         * everywhere in this app. EnvironmentVariables is the scalar
         * `VariableCollectionUpsertInput.variables` takes, and mapping it is what finally
         * types the map `createContainer` builds from the catalog defaults and the user's
         * rows. `unknown` rather than codegen's default `any` for the rest: an opaque
         * scalar this app does not select should be unusable, not silently assignable.
         */
        scalars: {
          DateTime: "string",
          EnvironmentVariables: "Record<string, string>",
        },
        defaultScalarType: "unknown",
      },
    },
  },
  // Formatted on write, so `pnpm format:check` has nothing to say about a generated file.
  hooks: { afterOneFileWrite: ["prettier --write"] },
};

export default config;
