/**
 * The two schema facts that are product decisions rather than derivable ones, plus the
 * input types the probe introspects.
 *
 * Everything else in `operations.ts` is a GraphQL document, read by `pnpm codegen` to
 * generate types and by `pnpm verify:schema` to validate against Railway's committed SDL.
 * These three are neither: they say which withdrawals the app has a designed answer for
 * and which fields it deliberately never sends, and no tool derives them from anything.
 *
 * Their own module because they answer to different readers — `scripts/verify-schema.ts`
 * and `operations.test.ts`, not the API layer — and because keeping them beside the
 * documents invited the question of whether codegen reads them. It does not:
 * `codegen.ts` points at `operations.ts` and these are no longer in it.
 */

/**
 * Documents whose withdrawal degrades a readout rather than breaking the app.
 *
 * Everything else here is a dependency, and `verify:schema` derives that from the documents
 * themselves: it validates each one against Railway's live schema, so a field, argument,
 * enum member or input member this app sends and Railway no longer offers exits non-zero.
 * There is no list of required fields to keep up to date any more, which is the point —
 * the old one could only ever name *root* fields, and named them by hand.
 *
 * These two are the exception, and each is exactly the trade its own document explains.
 * `Query.metrics` and `Query.deploymentEvents` are read through `gqlPartial`, on paths that
 * already render a designed answer when Railway says no, so failing the schema CI job over
 * one would be failing a build over a capability the app has a clean answer for. A
 * validation error inside these two documents is reported and does not fail the run.
 *
 * The exemption is per document rather than per field, which is wider than it needs to be
 * and costs nothing: `Query.project` is selected by ProjectMetrics as well, and it is a
 * hard dependency — but PROJECT_QUERY selects it too and is not exempt, so its withdrawal
 * still fails the run there.
 */
export const DEGRADING_OPERATIONS: Array<{ operationName: string; note: string }> = [
  /*
   * Where a failed deployment's reason lives. Losing it costs no capability: a failed row
   * degrades to exactly what it showed before — the status, the fallback sentence, and the
   * link to Railway's own page.
   */
  {
    operationName: "DeploymentEvents",
    note: "a failed row shows the status and a link, with no reason",
  },
  /*
   * The usage readout, and with it the only cost signal the app has.
   *
   * A metrics read Railway refuses must degrade the row, not blank the dashboard: the
   * container list, its filters and every destructive action are untouched by losing this,
   * and the readout falls back to the same em dash it shows for a container with no samples
   * yet.
   */
  {
    operationName: "ProjectMetrics",
    note: "container rows show no CPU, memory or uptime, and the list shows no usage total",
  },
  /*
   * Where a container's data lives, for the row and for the destroy dialog's checkbox.
   *
   * Losing it must not cost the app any correctness, and it does not: the destroy action
   * re-reads volumes with its own request, below the ownership check, so the decision about
   * what to delete is never taken from this read. What a withdrawal costs is the readout and
   * the checkbox — and the checkbox's absence means the flag is not sent, which means the
   * volume is kept and the toast says it was kept. The conservative branch is the one that
   * degrades to, which is the property that made it safe to make this optional at all.
   */
  {
    operationName: "EnvironmentVolumes",
    note: "container rows show no volume, and destroy keeps the data instead of offering the choice",
  },
  /*
   * The region list on the spin-up form's advanced panel.
   *
   * Losing it costs a choice rather than a capability: the select renders disabled with a
   * reason and Railway picks the region, which is exactly what happened before this app
   * offered one. The same trade ProjectMetrics makes, and it is worth naming what is
   * deliberately NOT here beside it — `ServiceInstanceLimitsUpdate` is a hard dependency,
   * because its withdrawal would leave a CPU field and a memory field that a person fills in
   * and that silently do nothing. A control that lies is the failure this job exists to
   * catch; a control that is honestly unavailable is not.
   */
  {
    operationName: "Regions",
    note: "the spin-up form offers no region choice, and Railway picks",
  },
  /*
   * The deployment history behind the rollback control.
   *
   * Degrading, and it degrades safely twice over: the expanded panel says the history could
   * not be read and offers no rollback, and `rollback` — which re-reads this same document to
   * check the posted deployment id is one of the service's own — refuses, because an empty
   * list contains nothing. Losing this cannot roll a container back to a deployment nobody
   * chose; it can only stop offering the choice.
   *
   * `DeploymentRollback` is deliberately NOT here, and the pair is the distinction this list
   * draws. A control that is honestly unavailable is fine. A control that is still rendered
   * over a mutation Railway has withdrawn is a control that lies, which is what the Regions
   * entry above says about `ServiceInstanceLimitsUpdate`.
   */
  {
    operationName: "Deployments",
    note: "an expanded row lists no earlier deployments, and rollback is not offered",
  },
  /*
   * The read-back that says what Railway actually stored for a service it just created.
   *
   * It feeds an audit line and nothing else — no pixel on any screen depends on it — so a
   * refusal costs the record its `stored_*` fields and costs the user nothing at all. That
   * is the strongest form of the trade every entry here makes, and the reason it must never
   * be able to fail a create: the container exists by the time this runs, and a throw here
   * would turn a successful spin-up into a reported failure over a diagnostic.
   */
  {
    operationName: "ServiceInstance",
    note: "the container.created record does not say what Railway stored for region, replicas or restart policy",
  },
];

/**
 * Capabilities Railway does not document in its public API guides, and this app does not
 * use. The verify script reports whether each exists, and `note` says what the app can or
 * cannot do without it — previously the script printed one hardcoded sentence for all of
 * them, which was already wrong for `serviceInstanceUpdate`.
 *
 * These cannot be derived from the documents for the same reason the entries above can: no
 * document mentions them. They are a wishlist against the live schema, which is why
 * `variableUpsert` is here while the collection form the app actually sends is not.
 */
export const OPTIONAL_FIELDS: Array<{
  root: "Query" | "Mutation";
  field: string;
  note: string;
}> = [
  /*
   * `deploymentStop` used to sit here, with the note "spin-down stays destroy-only". It is
   * a document now — see DEPLOYMENT_STOP_MUTATION — so its withdrawal fails the schema job
   * rather than being reported, which is the difference between a capability the app wants
   * and one it depends on.
   */
  {
    root: "Mutation",
    field: "deploymentRemove",
    note: "a stopped deployment's record cannot be erased, only the whole service",
  },
  /*
   * `deploymentRollback` used to sit here too, with the note "a container can be restarted
   * and redeployed, but never rolled back", and the reason given was that choosing a
   * deployment needed a UI over image tags nobody could see. `Deployment.canRollback` and
   * `Query.deployments` turned out to make the choice presentable without the image — see
   * DEPLOYMENTS_QUERY — so it is a document now and its withdrawal fails the run.
   *
   * `serviceInstanceUpdate` used to sit here too, with the note "a service cannot be edited
   * in place". It is a document now — see SERVICE_INSTANCE_UPDATE_MUTATION — so its
   * withdrawal fails the schema job rather than being reported as a capability the app might
   * one day want.
   */
  /*
   * The per-key fallback. `variableCollectionUpsert` is what the app actually sends, and a
   * document that sends it is what makes it a dependency; this entry is here so that if the
   * collection form is ever withdrawn the report names the replacement rather than leaving
   * the reader to find it.
   */
  {
    root: "Mutation",
    field: "variableUpsert",
    note: "no per-key fallback if variableCollectionUpsert is withdrawn",
  },
  /*
   * Renaming a volume, which this app deliberately does not do.
   *
   * T-491 planned to send it: create the volume, then stamp the service's managed name onto
   * it so the ownership prefix reached the volume too. Probing the live API made it
   * unnecessary — `volumeCreate` already names the volume after the service it attaches to,
   * so `spun-pg` gets `spun-pg-volume` with no second call, and a rename could only ever
   * write the name Railway had already derived. It stays listed because that is a Railway
   * behaviour rather than a documented guarantee: if the auto-name changes, this is the
   * mutation that would put the prefix back.
   */
  {
    root: "Mutation",
    field: "volumeUpdate",
    note: "a volume keeps the name Railway derives from its service, which is what carries the prefix",
  },
  /*
   * Changing where a volume is mounted, or moving it to another service, after creation.
   * Absent from the app for the reason the edit form states about images: a mount path that
   * moves under a running database is a data-loss shape, not an edit.
   */
  {
    root: "Mutation",
    field: "volumeInstanceUpdate",
    note: "a volume's mount path is fixed at creation and the edit form cannot offer it",
  },
  /*
   * The two ways of being reachable that T-485 looked at and did not take. Listed rather
   * than merely argued in SERVICE_DOMAIN_CREATE_MUTATION's docblock, because the report is
   * where the next person asking "why can I not reach my postgres" will look.
   */
  {
    root: "Mutation",
    field: "customDomainCreate",
    note: "a container is reachable only at the hostname Railway mints; a domain the user owns needs a DNS record this app cannot place",
  },
  {
    root: "Mutation",
    field: "tcpProxyCreate",
    note: "deprecated upstream in favour of staged changes, so the database and cache presets stay on Railway's private network",
  },
];

/** Printed, never enforced: the shape is unknown until the probe has been run. */
export const PROBED_INPUT_TYPES: string[] = ["VariableUpsertInput"];
