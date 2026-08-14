/**
 * The join between a GraphQL document and the types codegen generated for it.
 *
 * Railway's operations are plain strings — ADR-8 keeps the transport hand-rolled, so there
 * is no `TypedDocumentNode` from a client library to carry types for us. A brand does the
 * same job with nothing at runtime: `TypedDocument<R, V>` *is* a string, and the phantom
 * members exist only in the type system.
 *
 * They are optional, which is what lets a template literal be annotated with one directly.
 * That matters more than it looks: the alternative is a wrapper call around every document,
 * and the document strings in operations.ts are the thing this app is reviewed on.
 *
 * The binding happens at the definition, not at the call site — which is the defect this
 * closes. `gql<{ serviceCreate: { id: string; name: string } }>(SERVICE_CREATE_MUTATION)`
 * was two independent claims sitting next to each other, and nothing checked that the type
 * described the document or that the variables matched either.
 *
 * Deliberately not `server-only`: operations.ts imports this, and scripts/verify-schema.ts
 * imports operations.ts.
 */

declare const resultBrand: unique symbol;
declare const variablesBrand: unique symbol;

export type TypedDocument<TResult, TVariables> = string & {
  readonly [resultBrand]?: TResult;
  readonly [variablesBrand]?: TVariables;
};

/** The upper bound for "any document", for use as a generic constraint. */
export type AnyTypedDocument = TypedDocument<unknown, Record<string, unknown>>;

export type ResultOf<TDocument> =
  TDocument extends TypedDocument<infer TResult, unknown> ? TResult : never;

export type VariablesOf<TDocument> =
  TDocument extends TypedDocument<unknown, infer TVariables> ? TVariables : never;

/**
 * A result whose root fields may have been refused.
 *
 * What `gqlPartial` promises, in the type system: Railway nulls the field it refused and
 * reports it alongside whatever else resolved, so a document touching several independent
 * things has a usable answer even when one of them is refused. The generated types cannot
 * say that on their own — `Query.metrics` is `[MetricsResult!]` and `Query.me` is `User!`,
 * and both arrive null for a token that lacks the scope.
 *
 * Root fields only, and that depth is the whole point rather than a shortcut. GraphQL
 * propagates a null out to the nearest nullable ancestor, so a *nested* non-null field
 * never arrives as null — its parent does, and every nullable ancestor the app selects is
 * already `| null` in the generated types. Making the whole tree nullable would assert a
 * response Railway cannot send, and would buy it by forcing invented fallbacks into the
 * mappers for names and ids that are non-null in the schema.
 */
export type Refusable<TResult> = { [K in keyof TResult]: TResult[K] | null };
