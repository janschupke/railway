/**
 * Every event name this app emits.
 *
 * A catalogue, not logger code. It was half of `logger.ts` — 209 of that file's 422 lines —
 * sitting between the redaction config and the four-method surface, so a file whose subject
 * is *how* a line is written was mostly a list of *what* can be written. Nothing here
 * imports pino, and nothing here runs.
 *
 * Callers pass string literals checked against this union rather than importing the name, so
 * moving it changed no import site.
 *
 * `subsystem.thing.outcome`, dotted and low-cardinality. It becomes pino's `msg`, which
 * is what a Loki label and an OTel Body both want — and a label's whole value is that
 * the set of values is small and known. errors-and-logging.md said so and nothing
 * checked it: `event: string` accepted prose, a template literal, or an id, and the
 * first person to write `log.info(\`stream \${id} closed\`)` would have turned a label
 * into a cardinality explosion with no review signal at all.
 *
 * A union rather than a lint rule, because this is a question tsc can answer exactly.
 * Adding a name here is one line and is visible in a diff, which is the review the rule
 * was asking for.
 */
export type LogEvent =
  | "action"
  | "action.session_expired"
  | "auth.callback.failed"
  | "auth.callback.token_exchange_failed"
  | "auth.login.started"
  | "boot"
  | "boot.env_invalid"
  | "auth.logout.rejected"
  /*
   * The two halves of one rule, kept as separate names because they answer different
   * questions: `auth.` is a request to a route the proxy matcher excludes, so a burst of
   * those is somebody probing the sign-in flow, while `request.` is every other path.
   * Neither ever carries the host it refused — see lib/origin.ts.
   */
  | "auth.origin_rejected"
  | "request.origin_rejected"
  | "auth.redirect.anonymous"
  | "auth.session.cleared"
  | "auth.session.created"
  | "auth.session.refresh_failed"
  | "auth.session.refresh_raced"
  | "auth.session.refreshed"
  | "auth.session.unreadable"
  | "container.create_failed"
  | "container.create_replayed"
  | "container.created"
  /*
   * `destroy_failed` has no counterpart under the other verbs on purpose. They fail by
   * ending the request, which `reportError` records under `action`; destroy is the one that
   * can be asked about several containers at once, so a refused mutation there ends one
   * entry of a batch that carries on — and this is the only line that says which.
   */
  | "container.destroy_failed"
  | "container.destroy_refused"
  | "container.destroy_skipped"
  | "container.destroyed"
  /*
   * Editing, which takes the same three shapes as the verbs below plus one of its own:
   * `edit_rejected` is the duplicate-name refusal, and it is a different event from
   * `edit_refused` on purpose — one is the ownership boundary and the other is a name
   * already in use, which are a security record and a usability record respectively.
   * `container.updated` is the `.done` line, and the only record anywhere of what a
   * container used to be: Railway keeps no history of a service's previous name or image.
   */
  | "container.edit_refused"
  | "container.edit_rejected"
  | "container.edit_skipped"
  | "container.updated"
  /*
   * The rest of the lifecycle, in the same three shapes destroy has: refused by the
   * ownership boundary, skipped because the service had already gone, or done. Every
   * `.done` line here records a change to billable infrastructure, which is the reason
   * they are `info` rather than `debug` — see actions.ts.
   */
  | "container.redeploy_refused"
  | "container.redeploy_skipped"
  | "container.redeployed"
  | "container.restart_refused"
  | "container.restart_skipped"
  | "container.restarted"
  | "container.stop_refused"
  | "container.stop_skipped"
  | "container.stopped"
  /*
   * Rollback, in the same three shapes, and the one verb where `refused` and `skipped` carry
   * reasons the other five do not. `withManagedContainer` writes them for a service that has
   * gone or is not ours; these two are written afterwards, about the *deployment* the browser
   * chose — `not_in_service` for an id this service has never had, `not_rollbackable` for one
   * it has and Railway will not return to, and `current` for the one already running. The
   * first is the record that matters: it is the only line that says someone posted a
   * deployment id belonging to somewhere else.
   *
   * `container.rolled_back` carries `from_deployment_id` beside `deployment_id`, which no
   * other `.done` line needs — a rollback is the one verb after which what was running before
   * appears nowhere else in the trail.
   */
  | "container.rollback_refused"
  | "container.rollback_skipped"
  | "container.rolled_back"
  /*
   * Giving a container a public address. The same three shapes, and `domain_skipped` carries
   * a second reason the others do not: `exists`, for a stale page asking twice — Railway
   * mints a second domain rather than refusing, so that branch is the app declining rather
   * than reporting a Railway refusal.
   *
   * `container.domain_created` is `info` and part of the audit trail for the strongest
   * reason on this list: it is the record that a container was put on the public internet.
   * `railway.domain_failed` is the other half — a refusal during spin-up, which does not
   * fail the spin-up.
   */
  | "container.domain_created"
  | "container.domain_refused"
  | "container.domain_skipped"
  | "dashboard"
  | "dashboard.metrics_failed"
  | "dashboard.render"
  | "dashboard.selection_dropped"
  /*
   * The volumes read behind the container list. Debug, on every render, for the same reason
   * `dashboard.metrics_failed` is: a readout the app degrades out of by design is not an
   * incident, and a warn per render is how a log store teaches people to ignore warns.
   */
  | "dashboard.volumes_failed"
  /* The region list behind the spin-up form's advanced panel, on the same terms. */
  | "dashboard.regions_failed"
  /*
   * Neither has a `.destroyed` counterpart, and that is the design rather than a gap: this
   * app creates projects and environments and never deletes them, which is also why they
   * carry no MANAGED_PREFIX. See actions.ts.
   */
  | "environment.created"
  | "project.created"
  | "health.env_invalid"
  /*
   * The registry existence check. Both carry a `registry` and an `outcome` drawn from
   * closed sets and never the reference itself — it is an unbounded attacker-chosen string
   * arriving on a URL, and this endpoint fires on every settled keystroke, which makes it
   * the worst available candidate for a field an operator greps. Same call as the rejected
   * deploymentId on the stream route; `ref_length` carries the diagnostic content.
   */
  | "image.check_rejected"
  | "image.checked"
  | "proxy.env_invalid"
  | "railway.deploy_failed"
  /*
   * A domain Railway refused during a spin-up, and the only one of these `railway.*_failed`
   * names that does NOT stop the container being created. The container is deployed and the
   * user is told about it; what they are not given is an address, and the row's own control
   * is the retry. See createContainer.
   */
  | "railway.domain_failed"
  | "railway.deploymentPoll"
  | "railway.deployment.fallback_logs"
  | "railway.deployment.fallback_logs_failed"
  | "railway.deployment.failure_reason"
  | "railway.deployment.failure_reason_failed"
  | "railway.deployment.failure_reason_refused"
  | "railway.deployment.not_found"
  | "railway.deployment.poll_failed"
  | "railway.deployment.poll_recovered"
  | "railway.deployment.unsettled"
  /*
   * A service's deployment history refused. Debug beside `railway.metrics.refused` and for
   * the same reason: `Deployments` is a degrading read, so a token that cannot make it costs
   * one control and nothing else, and a warn per opened panel would train people past it.
   */
  | "railway.deployments.refused"
  | "railway.logBackfill"
  | "railway.logStream"
  | "railway.logStream.truncated"
  | "railway.metrics.refused"
  | "railway.projects"
  | "railway.projects.source_failed"
  | "railway.request"
  | "railway.request.retry"
  /*
   * The two resource-control steps of a spin-up, and they are two names rather than one for
   * the reason `createContainer` keeps them two mutations: Railway gates sizing by plan and
   * does not gate the rest, so a refusal of each says something different about the account.
   * Both stop the container being deployed.
   *
   * `start_command_length`, never the command. Every other field on `settings_failed` is
   * closed or bounded — a region from Railway's own list, a count under a LIMITS ceiling,
   * one of three policy names — and the start command is the one free-text field on the
   * panel, which is the split `container.created` already makes for variable names.
   */
  | "railway.settings_failed"
  | "railway.limits_failed"
  | "railway.variables_failed"
  /*
   * The volume a stateful preset is given, and the two ways that can go.
   *
   * `volume_created` is part of the audit trail rather than a counter: it records the name
   * Railway derived for the volume, which is what carries the ownership prefix onto it
   * (ADR-14), so a change in that behaviour shows up here rather than as a volume this app
   * quietly stops being able to identify. `volume_failed` is warn, and its consequence is
   * that the service is NOT deployed — a database that came up without its volume would
   * accept writes and lose them.
   *
   * `volumes.refused` is the read, not the write, and sits with `metrics.refused` in both
   * level and reasoning.
   */
  | "railway.volume_created"
  | "railway.volume_failed"
  | "railway.volumes.refused"
  /*
   * The panel reading a service's deployment history, for the rollback control. `deployment_
   * count` and never the ids, on the same argument `variables.read` makes below about names:
   * the answer to "did this panel get a history to choose from" is the number.
   */
  | "deployments.read"
  | "deployments.read_rejected"
  | "render.failed"
  | "stream.closed"
  | "stream.opened"
  | "stream.rejected"
  /*
   * The edit form reading which variables a service already has. `variable_count` and never
   * a name: the moment a person can type one, the set stops being closed and stops being
   * something to hand an operator's log store. Values reach neither this record nor the
   * response — see the route handler.
   */
  | "variables.read"
  | "variables.read_rejected"
  | "watch.closed"
  | "watch.opened"
  | "watch.poll_failed"
  | "watch.rejected";
