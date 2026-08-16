# Limitations

What this app deliberately does not do, and why. Each entry is a decision with a reason
rather than a gap waiting to be filled; where one is genuinely unresolved it says so.

[Walkthrough](../walkthrough.md) · [Decisions](adr/README.md) · [What I would do next](#what-i-would-do-next)

---

## Sources and registries

- **GitHub-repo sources are not offered** ([ADR-6](adr/0006-docker-images-only.md)). Supporting
  them means detecting whether the signed-in user's Railway account has the GitHub app
  installed, and sending them to install it — a real feature, not a line of code.
- **Private registries are not supported.** `serviceCreate` would need credentials this app
  does not collect.

## Reachability

**A public address is a Railway hostname on one port, and nothing else.** A spin-up whose
port field is filled in gets a `serviceDomain` — `spun-web-production.up.railway.app` — and a
container that has none can be given one from its row. Three things that are not offered,
each for its own reason:

**Custom domains.** `customDomainCreate` exists, and using it would mean asking someone to
place a CNAME this app cannot place, then reporting on a certificate issue it cannot
observe. The control would succeed and the domain would appear broken for reasons living in
someone else's DNS.

**TCP proxies.** This is why redis, postgres and the rest are reachable from the project and
nowhere else. `tcpProxyCreate` is the mutation, and it is `@deprecated` on the live schema —
"use staged changes and apply them", plus a redeploy the caller has to perform itself before
the proxy is active. Shipping the database presets' reachability on a retiring mutation is a
worse trade than leaving them on Railway's private network, which is where a database
usually belongs anyway.

**A port for an image the catalog does not know, from the row.** `Preset.httpPort` carries
the port for every image on the spin-up form, and the form's own field carries it for
everything else — but the row control posts three ids and no port, deliberately, so that a
request cannot aim a domain at a port of its choosing. For an unrecognised image it therefore
omits `targetPort` and lets Railway infer one from the running deployment. That inference is
undocumented. If it picks wrong, the fix is to destroy the container and spin it up again
with the port filled in.

## Resource controls

**They are set once, when the container is created.** Region, replicas, CPU, memory, restart
policy and start command are on the spin-up form, behind an Advanced disclosure.
`ServiceCreateInput` accepts none of them, so they are two follow-up mutations —
`serviceInstanceUpdate` for the settings and `serviceInstanceLimitsUpdate` for the size,
which Railway splits because the second is gated by the plan behind the token. Both run
before the deploy, and a refusal of either leaves the service created and un-deployed with
its own sentence, on the same argument the volume step makes: a container running in a region
nobody asked for is a container quietly not doing what the form said.

**They cannot be changed here afterwards.** An edit form carrying them would post seven blank
values for a service that is already running, and blank means "unset it" — so an edit path can
only carry them once it reads the current values back off `ServiceInstance` first.

**The CPU and memory ones are readable, though — from the metrics query rather than from the
service.** Each expanded row reads "0.25 of 2 vCPU", and the denominator is
`CPU_LIMIT`/`MEMORY_LIMIT_GB`, which arrive beside the usage in the same request. That is what
Railway is _enforcing_, which is not always what the form asked for: the size mutation is
gated by the plan behind the token, so a clamped request shows the clamped figure here — the
more useful of the two numbers, and the only one with a bearing on the bill. The other five
controls have no such route back and remain write-only.

**Ports, healthchecks and app sleep are not on that panel.** The target port is on the form
already, because it belongs to the public address rather than to sizing. The healthcheck path
is deliberately absent and follows it: Railway probes the path against the service's target
port, so a path set for a container with no address is a deployment that hangs in `DEPLOYING`
and then fails, on a control this app offered. `sleepApplication` is excluded because a
sleeping service makes three existing readouts lie — derived uptime, the CPU/memory snapshot,
and the watcher's fingerprint, which sees no change and reports a healthy container that is
not running. `drainingSeconds` and `overlapSeconds` are excluded because nothing here renders
them and nobody could check they applied.

**There is no entrypoint control, because there is no entrypoint member.**
`ServiceInstanceUpdateInput` has `startCommand` and nothing else, so a start command replaces
the image's CMD and its ENTRYPOINT still runs. Changing that means rebuilding the image.

## Editing

**Editing a container is a name, an image and its variables — nothing else.**
`ServiceInstanceUpdateInput` carries twenty-odd other members. The six the spin-up form sets
are create-time only; the rest — healthcheck, cron schedule, build and Nixpacks configuration,
watch patterns, private-registry credentials — are untouched on both paths, and each is a
feature with its own ticket rather than a field to pass through. Sending only `source` on an
edit is what leaves every one of them alone.

Two things about that mutation are worth writing down, because both cost time to find. **The
name is not on it.** Railway splits a service in two — `Service` holds the name,
`ServiceInstance` holds how it runs — so a rename is `serviceUpdate`, a second mutation
entirely, and any plan that assumes `serviceInstanceUpdate` can rename is wrong before it
starts. And **there is no `skipDeploys` member**, which `VariableCollectionUpsertInput` has:
if Railway redeploys on a source change there is no way to ask it not to. So the edit issues
its own `serviceInstanceDeployV2` afterwards and keys the row on the id that returns — the
later deployment is the one being watched either way, at the cost of possibly causing two.

**A partial edit is possible, and the list is what tells you.** The rename and the image
change are separate calls; the first can land and the second be refused. Neither is rolled
back — this app has no transaction to roll back into — so the refreshed row shows what actually
applied rather than what was asked for. The alternative was reporting the whole edit as failed
while half of it had happened, which is worse in the only way that matters.

## Cost and readouts

**Cost is a workspace figure, not this app's — and the form can multiply it.** Replicas times
vCPU times memory is the first thing this app lets anyone set that changes the bill, and it
still cannot say by how much. The dashboard shows what the workspace a project belongs to has
spent this billing period, and says so in the same sentence, because that is the only monetary
number Railway exposes: `Customer.currentUsage` and
`CustomerSubscription.nextInvoiceCurrentTotal`, both workspace-wide. `estimatedUsage` sounds
like the answer and is not — asked against a real project it answered `CPU_USAGE: 1.27` and
`MEMORY_USAGE_GB: 494.8`, magnitudes rather than money, and there is no dollar measurement
anywhere in `MetricMeasurement`. So this app cannot tell you what the containers it created
cost, only what the workspace they live in has spent, and the usage total beside the list is in
vCPU and GB for exactly that reason.

Three cases have no figure at all: a personal project, which belongs to no workspace; a token
without `workspace:viewer`, which cannot read one; and `Customer` being withdrawn, which the
`ProjectMetrics` document is now validated against the schema for — three types below a root
field and no longer invisible, since `pnpm codegen` reads `customer { currentUsage
billingPeriod { start end } }` as part of the document. All three render a link to Railway's
own billing page rather than a number this app would have to caveat further.

The one record of what was asked for is the `container.created` log line, which carries the
region, the replica count and the size — Railway keeps nothing once a service is destroyed. The
per-row ceiling is the one figure here that is capacity rather than consumption, which is why
the total under the list does not sum it: Railway bills measured usage, and "6 vCPU
provisioned" beside a dollar amount would read as a claim about the bill that is not true.

**Uptime is derived, and it counts the build.** There is no started-at anywhere in the schema,
so it is measured from `latestDeployment.createdAt` — when the deployment was _queued_. For a
Docker image source, which is all this app creates ([ADR-6](adr/0006-docker-images-only.md)),
that overstates by the few seconds of pull and boot. For anything slower it would overstate by
more.

**The readouts are a snapshot, not a graph.** One point per service per measurement, sized to
the request budget rather than to what `Query.metrics` will return: a wider window and a faster
`sampleRateSeconds` would give a sparkline at no extra _request_ cost but a much larger
response, and the readout is deliberately the cheap half. Four measurements are asked for — two
usage, two ceilings — which doubled the response and left the request count exactly where it
was, because `measurements` is a variable on one document rather than a query per measurement.
`Query.metrics` is in `DEGRADING_OPERATIONS`, so losing it costs the readouts and the usage
total and nothing else — the row falls back to the same em dash it shows for a container with no
samples yet.

## Projects, environments and volumes

**Projects and environments can be created here but never deleted here.** `projectCreate` and
`environmentCreate` have documents, which is what makes them dependencies; `projectDelete` and
`environmentDelete` are absent from `operations.ts` entirely, so no request shape reaches them.
This is not a gap waiting to be filled. Deleting a service is bounded — the `MANAGED_PREFIX`
check means this app only ever deletes what it created, and what it created is one container.
Deleting a project takes every service, environment and volume inside it, including the ones
this app did not create and cannot see the value of, and no ownership marker on the project
makes that safe: the blast radius is the contents, not the wrapper. So the prefix is not
applied to them either — it gates destroy, and there is no destroy to gate. Removing a project
is done in Railway's own dashboard, where the consequences are stated by the people who own the
billing relationship.

**A new environment is empty.** `environmentCreate` is sent with `skipInitialDeploys` and
without `sourceEnvironmentId`, so nothing is copied in and nothing is deployed. Railway's own
dashboard duplicates an existing environment instead; that is the more useful default for
someone who has already set a project up, and the more expensive one to hand to a button whose
consequences are not on screen.

**Volumes are attached to the presets that need one, and to nothing else.** postgres, mysql,
mariadb, mongo, redis and rabbitmq each carry a mount path in the catalog and get a volume
before their first deploy — before, because a first deploy without the mount runs the image's
own initialisation against the container filesystem and the next deploy mounts an empty volume
over the top of it. An image the catalog does not know gets none, and the spin-up form says so:
this app cannot guess where an arbitrary container writes, and a volume mounted at the wrong
path is billable storage that stays empty while the data still vanishes.

Five further caveats, none of them oversights. **Size is Railway's plan default** —
`VolumeCreateInput` has no size member, so there is nothing to offer. **A mount path is fixed at
creation**; `volumeInstanceUpdate` could change it and is deliberately absent, for the reason
the edit form gives about images. **There are no backups and no point-in-time restore**, both of
which Railway exposes and neither of which has a UI here. And **a volume is listed a few seconds
after it is created** — about three, measured, on `environment.volumeInstances` — so a container
destroyed inside that window keeps its volume. That is the cautious outcome and the toast says
so, which is the property
[ADR-14](adr/0014-a-volume-belongs-to-the-service-that-mounts-it.md) rests on: every way of not
knowing about a volume ends in keeping it and saying it was kept.

And the fifth, measured live: **`volumeDelete` schedules a deletion rather than performing one.**
The volume answers immediately afterwards with `isPendingDeletion: true` and a `deletedAt` about
two days out, and it is gone from `environment.volumeInstances` at once — so the app's own view is
correct and the destroy toast's "and its stored data" is true eventually rather than at the
moment it is read. What that costs is narrow and worth stating: the data is recoverable through
Railway for those two days, which is a safety net rather than a defect, and the storage remains
provisioned until it is not. Nothing in this app can shorten it or read the pending state.

## Environment variables

**They are single-line, and capped.** Twenty-five rows, 2 048 characters a value, 16 000
characters in total, and no line breaks — so a certificate, a private key or a JSON document is
set on Railway's own Variables page rather than here. Names in the `RAILWAY_*` namespace are
refused, because Railway sets those itself. The caps are `VARIABLES_MAX`, `VARIABLE_VALUE_MAX`
and `VARIABLES_TOTAL_MAX` in [src/lib/constants.ts](../src/lib/constants.ts).

**An existing container's variables are edited by name, never by value.** The edit form lists
what a service has and leaves every value cell empty: a stored value — minted or typed — is
filtered out server-side and reaches no browser, so blank is what an untouched row looks like
and the server reads it as "leave this one alone". Retyping a cell replaces that variable;
removing the row deletes it, one key at a time rather than by replacing the collection. Shared
variables the environment sets for every service are not listed, because they are not this
service's to change. The consequence worth stating: there is no way to read a value back here,
and Railway's own Variables page is still where you go for that.

## The image-existence check

**It is advisory only, and covers three registries.** A well-formed reference used to be
accepted whatever it named, so `nonexistent/image:tag` became a failed deployment with nothing
on screen connecting it to the typo. The form now asks Docker Hub, ghcr.io or quay.io for the
manifest as the field settles, and warns beside it — a warning, not a validation error: nothing
is refused, `aria-invalid` is not set, and the submit button stays live.

This was refused twice before on two grounds, and both were right about the naive version. The
first was an SSRF that did not exist yet: `IMAGE_PATTERN` admits a bare host as the first
component, and Docker's own rules make a first component containing a dot a registry, so
`169.254.169.254/foo/bar` is a valid reference and dereferencing user input would reach cloud
metadata. What closes it is refusing rather than resolving — three registries with their base
_and_ token URLs as compile-time constants in
[src/lib/registry/registries.ts](../src/lib/registry/registries.ts), no `WWW-Authenticate` realm
ever followed, and `redirect: "manual"` so a registry cannot choose a URL either. Nothing derived
from user input is ever a host, a port or a scheme; a reference naming anything else is parsed,
reported as unsupported, and never dereferenced.

The second was shared egress, and that one turns out to have been about the wrong verb. A
manifest `HEAD` does **not** consume Docker Hub's anonymous pull budget and a `GET` does —
measured against `library/redis:7-alpine`, where two `HEAD`s left `ratelimit-remaining` at
`100;w=3600` and a `GET` took it to 99. The check is `HEAD` only. The cache, the per-registry
cool-off after a 429 and the per-user concurrency cap are insurance against the request rate
underneath that published budget, not against the budget itself, and a preset is never checked
at all — the catalog exists by construction, and it is the field's default value.

**What it still does not catch**, which is most things: architecture mismatches, images that
need credentials, a tag deleted between the check and the deploy, and any registry outside those
three. A registry that is rate-limiting, timing out or down produces `unknown`, which renders
nothing — a check that could stop a spin-up would be worse than the failed deployment it is
warning about. And on all three registries, "no such repository" and "private repository" are
the same 401 or 403 with no way to tell them apart anonymously, so one sentence covers both.
That is honest rather than vague: this app collects no registry credentials, so a private image
fails to deploy exactly as an absent one does.

## Failure reasons

**A failed deployment's reason is best effort, and Railway's page is still the fallback.** The
deployment query returns a status and nothing else, so a failure reaches the poll loop as the
enum `FAILED`; the `Deployment` type carries no explanation at all, and `diagnosis` and `meta`
are opaque `SCALAR`s with no documented shape. The reason lives on `deploymentEvents`, which the
monitor reads **once**, on the terminal-failed transition, as its own document — never from the
status poll, which runs for the life of every open stream and would turn a withdrawn field into
a schema rejection the monitor treats as transient and now backs off from, so the silence would
last the full duration ceiling and be quieter than before. `DeploymentEvents` is in
`DEGRADING_OPERATIONS`, so `pnpm verify:schema` reports its withdrawal without failing, and a row
whose feed is empty, refused or withdrawn shows exactly what it showed before: the status, the
sentence, and the link out.

One thing stays unresolved, and one has since been answered. **It is `payload.error`.** Measured
against the live API on a deployment that failed pulling an image that does not exist: the last
event is step `CREATE_CONTAINER` with `error: "Failed to create deployment."`, and `reason` and
`detail` both null. So the app's newest-event-first preference order was right, and the field it
lands on first is the populated one — `pnpm probe:deployment <id>` remains the way to re-check
it; see [Schema verification](schema.md#when-a-failed-row-does-not-say-why). Worth naming what
that sentence is worth: it says a container was not created and not why, which is Railway's
answer rather than a loss in transit.

What stays unresolved is the timing. The reason arrives on
**expand**, not on page load: the stream only opens for a settled container once its panel is
open, and fetching per failed row at render time is the cost profile the whole streaming design
exists to avoid.

Verification can now see a withdrawn member of `DeploymentEventPayload`, two types below the
root field: the document itself is validated against Railway's schema, `payload { error reason
detail skipped }` included, and `pnpm codegen` refuses to generate a type for a selection Railway
no longer offers.

## Lifecycle

**A container can be stopped, restarted, redeployed, rolled back and destroyed.** Stop is
`deploymentStop`, restart is `deploymentRestart`, rollback is `deploymentRollback`, and redeploy
is `serviceInstanceDeployV2` rather than the obvious `deploymentRedeploy`: that one takes a
deployment id, and a service whose first deploy Railway refused has none — which is exactly the
row most in need of the control. The four reversible verbs confirm with a sentence and two
buttons rather than the destroy dialog's typed name — friction is priced in what it protects.
What "spin up" does to a stopped service is nothing: it creates, the duplicate-name check
refuses a second container by that name, and the row's own **Redeploy** is the way back.

`deploymentRemove` is the one lifecycle call still in `OPTIONAL_FIELDS`, reported by
`verify:schema` and sent by nothing: it erases a stopped deployment's record, which is the one
thing it destroys that `serviceDelete` does not already take.

**Rolling back names a time, not an image — because Railway will not say what a deployment ran.**
`Deployment.meta` is an opaque `SCALAR` like `diagnosis`, so no request this app can make will
tell it which image a past deployment used. What the app _can_ read is `createdAt`, `status` and
`canRollback` — enough for "the deployment from 14:32 that succeeded", which is a choice a person
can make. So an expanded row on a managed container lists its recent deployments, marks the one
running now, and offers a rollback on each entry Railway itself says it would accept. An entry it
says no to is shown without a control rather than left out, because the deployment that broke
things is usually beside the one someone is looking for.

Three things worth knowing about how it is wired:

**The list comes from `Query.deployments`,** not `service.deployments` or `project.deployments` —
both are `@deprecated` in favour of `environment.deployments`, which takes pagination only and
cannot be narrowed to one service. The root field takes `DeploymentListInput` and is the only one
of the four that answers for a single service in a single request. It is read when a panel is
opened, never with the list, on the same cost argument the variables read makes: twenty rows
would otherwise be twenty requests for panels nobody has opened.

**It is the one request in this app that posts a deployment id.** Every other lifecycle verb
reads that id off the container the ownership guard just re-derived from Railway's own answer; a
rollback target is by definition in the past, so there is nothing current to read it from. What
replaces the derivation is the same shape destroy uses for a volume: the action re-reads the
deployment list, scoped by the service id Railway returned rather than the one posted, and
refuses any id that is not a member of it with `canRollback` set. The list read is in
`DEGRADING_OPERATIONS`, so a refusal yields an empty list — and an empty list contains nothing,
which is the direction this has to fail in.

**Whether a rollback mints a new deployment id is unobserved, and nothing depends on it.**
`deploymentRollback` answers a Boolean, so the response says nothing, and finding out would mean
performing a real rollback on a real account — every probe here is read-only. The row re-reads
the container list afterwards and re-keys its log stream on whatever id comes back, exactly as it
does after a redeploy, so both behaviours look the same from here. The e2e fixture mints a new
one deliberately, because that is the case the browser has to notice. `pnpm probe:deployments`
settles the questions that _are_ answerable read-only: whether a delegated OAuth grant may call
the field at all, which order the edges arrive in, and what `canRollback` answers for a running
deployment versus a finished one.

## Single replica, and the state that says so

- **SSE pins a client to one replica**, so this is a single-replica app today. Three pieces of
  module state say so out loud: the stream cap in
  [src/lib/stream-slots.ts](../src/lib/stream-slots.ts), the idempotency map in
  [src/lib/idempotency.ts](../src/lib/idempotency.ts), and the stopped-container map in
  [src/lib/railway/stopped.ts](../src/lib/railway/stopped.ts).
- **A stopped container reads as running again after a restart**, because the map that remembers
  the stop does not survive one. Railway leaves a stopped deployment at `SUCCESS` indefinitely
  and offers no field anywhere that says one is stopped, so this app remembering what it stopped
  is the only way the row can say so — and the memory is per replica and per process. It also has
  no expiry, deliberately: an entry that timed out would flip the watch fingerprint back and tell
  every open tab that a still-stopped container had returned to Running. Bounded by size instead.
  [ADR-4](adr/0004-no-database.md) carries the paragraph that admits the exception.
- **A stream open to its ceiling** outlives nothing: `STREAM.MAX_DURATION_MS` is fifteen minutes,
  clamped further to whatever is left of the access token. Deploys finish well inside that; a
  long-lived streaming session would need mid-stream token rotation.
- **Double-submit protection expires, and does not survive a restart.** A submission carries an
  idempotency key and a repeat of it is answered with the first one's result rather than a second
  container ([ADR-12](adr/0012-idempotency-keys-replay-rather-than-reject.md)), but that entry is
  held in memory for `IDEMPOTENCY.RETAIN_SECONDS` on one replica. A repeat after that window, or
  across a deploy that lands between the two halves of a double submit, still creates two
  services. Both windows are far narrower than the name check this replaced, which was not a lock
  at all.
- **The duplicate-name message is stale by design.** It moved into the browser, where it is
  checked against the list the page has already loaded, so it costs nothing — and it cannot see a
  container created a second ago in another tab. It is a typo guard; the idempotency key is the
  part that is load-bearing. The ownership re-derivation in `spinDown` is a genuine safety
  property and stays ([ADR-5](adr/0005-the-app-only-destroys-what-it-created.md)).

## Auth

- **No `nonce` in the OIDC flow** ([ADR-1](adr/0001-railway-oidc-directly-not-an-auth-vendor.md))
  — `state` and PKCE only. Defensible with `response_type=code` plus PKCE `S256`, since the code
  is bound to the verifier and the id_token is never accepted from a redirect, but it is a
  deviation from the OIDC core recommendation and worth stating rather than leaving to be
  discovered.
- **Sign-out is local only, because Railway offers nothing else.** It deletes the session cookie,
  and the grant stays live at Railway until it expires or the user removes the app. That is not a
  call this app declined to make: the discovery document publishes no `revocation_endpoint` and no
  `end_session_endpoint`, and the paths a provider of this shape would put them on —
  `/oauth/token/revocation`, `/oauth/revoke`, `/oauth/revocation`, `/oauth/session/end`,
  `/oauth/logout` — all answer 404 to a POST that `/oauth/token` answers with `invalid_request`.
  So the sign-out notice on the landing page says both halves of what happened and points at
  Railway's account settings, which is where the authorization is actually removed, and
  `verify:schema` asserts both endpoints are still absent on every push — when one appears, CI goes
  red and this entry is wrong. The standing cost is in
  [src/lib/auth/refresh.ts](../src/lib/auth/refresh.ts): a refresh token is abandoned rather than
  revoked on each sign-out, against a cap of 100 live tokens per authorization.

## Announcements

- **A project switch announces once, at the start.** `useTransition`'s pending state ends when the
  skeleton commits rather than when the containers arrive, so the polite "Loading containers…"
  fires as the wait begins and the skeleton carries the rest. A live region that stayed accurate
  for the whole wait would cost a client provider to extend an announcement already delivered.

---

## What I would do next

- **Scale-out:** extract a WebSocket gateway service with Redis pub/sub, holding one upstream
  subscription per deployment and fanning out to N viewers, instead of one upstream connection per
  viewer per replica. That is what SSE's replica affinity forces once there is more than one
  instance.
- **An audit log** of spin-up/spin-down per user — now half done. The events are recorded
  (`container.created`, `container.create_failed`, `container.create_replayed`,
  `container.destroyed`, `container.stopped`, `container.restarted`, `container.redeployed` and a
  `…_refused` per verb, with the subject and the ids), and the field set is deliberately the shape
  a table would take, so the remaining work is a parse rather than a re-instrumentation. What a
  database adds is retention beyond the log window and a query the user can run themselves.
- **A sparkline per row, and a per-container cost estimate.** The first is a wider `startDate` and
  a faster sample rate on a query the app already sends — a response-size decision rather than a
  request-budget one. The second is arithmetic over `Query.usage` and Railway's published unit
  prices, which would make it _this app's_ estimate of a number Railway does not publish per
  project, and it would have to be labelled as such everywhere it appeared. Both are wanted;
  neither should arrive quietly.
- **Ship the logs somewhere.** [ADR-9](adr/0009-structured-logs-on-stdout.md) cut the seam and left
  it unused: add the OTel packages, add `register()` to
  [src/instrumentation.ts](../src/instrumentation.ts), point Grafana Alloy at Railway's log drain.
  Nothing in `src/**` outside that one file should need to change — that is the test of whether the
  seam was cut in the right place.
- **Move off the two deprecated reads**, which the deprecation report in `pnpm verify:schema` named
  as soon as it existed. `User.projects` is marked _"This field will not return anything anymore,
  go through the workspace's projects"_ and `Service.serviceInstances` is marked _"Use
  environment.serviceInstances for properly scoped access control"_ — the personal project source
  and the container list, so the two most important reads in the app. Both still answer, which is
  why this is a plan rather than a bug. It is also a candidate explanation for
  [the empty-project-list case](schema.md#when-the-dashboard-says-there-are-no-projects), and the
  reason to do it before Railway makes the decision for us.
- **Budget guards:** a per-user cap on concurrent containers, and a TTL that reaps them
  automatically — the obvious next thing for a tool whose whole purpose is creating billable
  infrastructure.

---

[Walkthrough](../walkthrough.md) · [Railway Freight Loader](../README.md)
