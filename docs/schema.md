# Typed documents and schema verification

Railway publishes no schema artifact and their API guides omit several things this app
depends on, so the schema is dumped from live introspection and committed.

```bash
RAILWAY_TOKEN=… pnpm schema:pull    # src/lib/railway/schema.graphql
pnpm codegen                        # the documents' result and variable types, from that file
```

`pnpm codegen` validates every document in
[src/lib/railway/operations.ts](../src/lib/railway/operations.ts) against that schema and
generates `src/lib/railway/graphql.generated.ts` — exactly the operation types plus the enums
and input objects the documents reach. Each export in `operations.ts` is annotated with its
pair:

```ts
export const PROJECT_QUERY: TypedDocument<ProjectQuery, ProjectQueryVariables> = …
```

so `gql`/`gqlPartial` read both off the document and a call site passes no type argument at
all. What that replaced was `gql<{ project: ProjectNode & { services: Edges<ServiceNode> } }>`
— a result shape restated by hand next to the document it claimed to describe, checked by
nothing, alongside a `variables` argument typed `Record<string, unknown>`. A renamed nested
field now fails `pnpm codegen`; a variable of the wrong type fails `pnpm typecheck`.

## The artifact is in git

That is the decision the rest of this rests on. CI holds no `RAILWAY_TOKEN`, so a schema
fetched at build time would mean neither the typecheck nor the codegen gate could run there —
and a generated file nobody can regenerate is a file nobody can check.

Committed, `pnpm codegen:check` is part of `pnpm check` and of the `quality` job: regeneration
must be a no-op, so a document edited without regenerating fails the merge. Committing it also
makes a Railway-side change readable as lines in a pull request rather than as a runtime
`undefined`.

## Verifying against the live API

```bash
pnpm verify:schema                       # discovery + documents vs the committed schema
RAILWAY_TOKEN=… pnpm verify:schema       # + documents vs the live API, and the drift between
```

With a token, [scripts/verify-schema.ts](../scripts/verify-schema.ts) introspects the live API,
validates every document against **it** rather than against the committed copy, and then diffs
the two over the surface the documents reach. The diff is what catches a change validation
cannot see: a field going from `String!` to `String` validates perfectly and makes every
non-null claim in the generated types a lie. An input member becoming required is the same
class, and is invisible to a document because the app builds those objects in TypeScript.

**There is no field list to maintain.** `REQUIRED_FIELDS`, `REQUIRED_INPUT_TYPES` and
`REQUIRED_ENUM_MEMBERS` are gone — three hand-written manifests that could only ever name _root_
fields, and said nothing about the selections underneath them. What survives is in
[src/lib/railway/schema-policy.ts](../src/lib/railway/schema-policy.ts), because neither entry is
derivable from a document:

- **`DEGRADING_OPERATIONS`** — `DeploymentEvents`, `ProjectMetrics`, `EnvironmentVolumes`,
  `Regions` and `Deployments`, the documents whose refusal degrades a readout rather than
  breaking the app. A validation error inside those is reported and does not fail the run. That
  is a product decision, not a fact about the schema. `DeploymentRollback` is deliberately not
  among them although it is the mutation `Deployments` supplies: a control that is honestly
  unavailable is fine, and a control still rendered over a mutation Railway has withdrawn is a
  control that lies.
- **`OPTIONAL_FIELDS`** — capabilities Railway does not document and this app does not use, each
  with what the app cannot do without it: `deploymentRemove`, `variableUpsert`, `volumeUpdate`,
  `volumeInstanceUpdate`, `customDomainCreate` and `tcpProxyCreate`. All exist and none is sent;
  [Limitations](limitations.md) says why for each. No document mentions them, so no derivation
  can find them.

`deploymentStop`, `serviceInstanceUpdate` and `deploymentRollback` were all listed in
`OPTIONAL_FIELDS` and are documents now, which is the whole distinction that list draws: a
capability the app wants is reported, a capability it depends on fails the run.

`checkSubscriptions` is the same idea one level up: it fails the build if a project or service
subscription appears — the thing [ADR-10](adr/0010-the-dashboard-watches.md) rests on not
existing — and prints what Railway offers and this app does not use.

## Deprecations are reported, not gated

The run prints every deprecated field the app selects. Two turned up on the first run and both
are load-bearing:

- **`User.projects`** — _"This field will not return anything anymore, go through the workspace's
  projects"_
- **`Service.serviceInstances`** — _"Use environment.serviceInstances for properly scoped access
  control"_

They still answer, and moving off them is on the
[list of what I would do next](limitations.md#what-i-would-do-next). A deprecation is an
announcement, and the app keeps working until the field goes.

CI runs the discovery check and the committed-schema validation on every push; the live
comparison is local, because CI has no token to make it with.

---

## When the dashboard says there are no projects

Verification proves the document is valid, which is a different claim from the data being there
— and the project list is read from `me`, where `User.projects` is deprecated upstream with the
notice above. When the dashboard reports an empty list for an account that plainly has projects,
the cause is one of four things that look identical from the outside: consent granted a narrower
scope than was asked for, the OAuth token sees a different viewer than the browser session, the
projects hang off a connection the app does not query — which that deprecation says is now the
likeliest of the four — or there genuinely are none.

Note the shape of Railway's refusal, because it is not the one the spec suggests: an unauthorized
field returns **HTTP 200** with
`{"message":"Not Authorized","extensions":{"code":"INTERNAL_SERVER_ERROR"}}`. Matching only
`UNAUTHENTICATED`/`FORBIDDEN` classified every permission problem as a generic operation failure —
which is how the UI came to show "Railway rejected the operation. Reference …" beside a Retry that
could not possibly work, while withholding the re-authorize that would have.

[scripts/probe-projects.ts](../scripts/probe-projects.ts) tells them apart, using the session's
**own** OAuth access token rather than an account token — those two credentials have different
visibility, and it is the OAuth one that is in question:

```bash
RC_SESSION="<rc_session cookie value>" pnpm probe:projects
```

Copy the cookie from DevTools → Application → Cookies. It prints the granted scopes against the
requested ones, the raw payload from each candidate project source, and a type-level
introspection of `User` and `Query`. Read the payloads before changing `PROJECTS_QUERY` — that is
what the script is for.

## When a failed row does not say why

[scripts/probe-deployment.ts](../scripts/probe-deployment.ts) answers the one question
introspection could not. The `deploymentEvents` feed and its `DeploymentEventPayload` were
confirmed against the live schema, but _which_ of `payload.error`, `payload.reason` and
`payload.detail` Railway fills in on a real failure has never been observed — so the app tries all
three in a documented order, and this checks that order against a real deployment:

```bash
RC_SESSION="<rc_session cookie value>" pnpm probe:deployment <deployment-id>
```

Take the id from a failed deployment's URL on Railway. It prints every event verbatim, which text
members were populated, and what the app's own picker chose from them. If the populated member is
not the one that won, reorder `TEXT_MEMBERS` in
[src/lib/railway/failure-reason.ts](../src/lib/railway/failure-reason.ts) and correct the
[Limitations entry](limitations.md#failure-reasons) — nothing else in the app depends on which one
it is.

## The other probes

All six are read-only and take `RC_SESSION` from a browser cookie, so each runs against the same
credential the app holds rather than an account token.

| Command                   | Answers                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `pnpm probe:projects`     | Which project source returns anything, and with what scopes                                                      |
| `pnpm probe:deployment`   | Which `DeploymentEventPayload` member carries a real failure reason                                              |
| `pnpm probe:deployments`  | Whether a delegated grant may read deployment history, and in which order                                        |
| `pnpm probe:logs`         | What the log subscriptions actually push                                                                         |
| `pnpm probe:metrics`      | What `Query.metrics` returns for a real project                                                                  |
| `pnpm probe:subscription` | Whether `Subscription.deployment(id:)` is reachable — see [ADR-3](adr/0003-sse-downstream-websocket-upstream.md) |

---

[Walkthrough](../walkthrough.md) · [Railway Freight Loader](../README.md)
