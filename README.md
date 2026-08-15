# Railway Freight Loader

Spin containers up and down in **your own** Railway projects, from a browser.

**Live: <https://trains.schupke.io>** — signing in needs a Railway account, and it
only ever acts on that account's own projects.

Sign in with Railway, pick which projects to share on Railway's consent screen, choose a
project and environment, and create Docker-image services — then stop, restart, redeploy
or destroy them — with live build and deploy logs streamed while it happens.

---

## Contents

**Start here** — [Running it](#running-it) · [Architecture](#architecture) ·
[Limitations](#limitations) · [What I would do next](#what-i-would-do-next) ·
[Verifying it works](#verifying-it-works)

**Reference** — [Decisions (14 ADRs)](#decisions) · [Tests](#tests) ·
[Design system](#design-system) · [Internationalisation](#internationalisation) ·
[Performance](#performance) · [Accessibility](#accessibility) · [Logs](#logs) ·
[Typed documents](#typed-documents-and-schema-verification) · [Security](SECURITY.md) ·
[License](#license)

---

## Running it

```bash
pnpm install
cp .env.example .env           # then fill in the values
pnpm dev
```

Register the OAuth app under your Railway workspace's **Developer settings**, with one
redirect URI per domain the app is reached on (they must match exactly):

```
http://localhost:3000/api/auth/callback
https://<your-deployment>.up.railway.app/api/auth/callback
```

The deployed instance also registers `https://trains.schupke.io/api/auth/callback`.
Sign-in follows the domain the request arrived on, so a domain whose callback is not
registered is refused by Railway rather than by this app.

`SESSION_SECRET` can be anything with enough entropy: `openssl rand -base64 32`.

### Deploying

Connect the repo to Railway; `railway.json` points it at the `Dockerfile` and sets the
`/api/health` healthcheck. There is no start command there — the image carries its own, and
the runtime stage has no package manager to run one with. Set `RAILWAY_CLIENT_ID`,
`RAILWAY_CLIENT_SECRET` and `SESSION_SECRET` as service variables. There is no origin to
configure: the app serves whatever domain the request arrived on.

#### Custom domains

Point the domain at the service and register its `/api/auth/callback` on the OAuth app.
That is the whole procedure — no variable to set, and any number of domains work at once.
Two consequences worth knowing:

- **Sessions are per domain.** The session cookie carries the `__Host-` prefix, which
  binds it to exactly one origin, so signing in on one domain does not sign you in on
  another.
- **`APP_ORIGINS` locks it down** if you would rather the app answered only for domains you
  have listed. Unset, it answers for any host Railway's edge reports —
  [ADR-13](docs/adr/0013-the-origin-is-the-request-not-a-variable.md) argues why that is
  safe here. Setting it does not implicitly include the generated `*.up.railway.app`
  domain; list every domain you serve.

The `Dockerfile` pins its base image by sha256 digest as well as by tag, on both `FROM`
lines, and the runtime stage strips npm, corepack and yarn — none of which the app calls
and all of which the base image ships. The deployed image carries OCI labels, including
`org.opencontainers.image.revision`, taken from `RAILWAY_GIT_COMMIT_SHA`: the same commit
the logger stamps on every line, on the artefact rather than only in its output.

It ships a **traced** `node_modules` — `output: "standalone"` — rather than an installed
one. That took the app payload from 504 MB to 44 MB, and the difference was almost entirely
other people's peer dependencies: pnpm resolves optional peers at lockfile time and writes
them into the resolved package's identity, so `next` was literally named
`next@16.3.0(@babel/core@7.29.7)(@playwright/test@1.62.1)(@types/node@20.19.43)…` and
`pnpm install --prod` could not drop any of them. Playwright and TypeScript were being
deployed because they are devDependencies of the same package.json. Tracing asks what the
server imports instead, and the answer is 38 MB of `node_modules` — 44 MB once `.next` and
the message catalog are counted, which is the number quoted above and everywhere else.

The cost is that `next start` does not serve a standalone build, so `pnpm start`, the
Playwright `webServer` and `scripts/serve-e2e.ts` all run `node .next/standalone/server.js`
— the same file the container runs. `pnpm build` finishes with `scripts/pack-standalone.ts`,
which copies in the static assets Next deliberately leaves out, checks the message catalog
was traced, and deletes the `.env` that `next build` otherwise copies next to the server.

The app deploys itself the same way it deploys containers.

### Checks

```bash
pnpm check          # format:check + lint + typecheck + codegen:check + cursor:check + knip + test:coverage
pnpm build && pnpm test:e2e   # Playwright against the fake Railway fixture
pnpm build && pnpm size   # per-route first-load JS against bundle-budgets.json
pnpm lighthouse     # LHCI: scores + resource budgets, one Chrome
pnpm verify:schema  # pinned OIDC metadata, and every document against the committed schema
```

Two more gates have no local script at all, because what they check is not the source tree.
(The four above do have one and are simply not part of `pnpm check`; `.ai/rules/workflow.md`
sets out which count is counting what.)

```bash
docker build -t rw .   # then boot it and curl /api/health; hadolint and Trivy over it
                       # — the exact commands are in .ai/rules/workflow.md
gitleaks git --log-opts=--all   # the whole history, every run, redacted
```

CI runs all of these on every push and pull request to `master`, plus a Monday cron, as six
parallel jobs behind a single `All checks` gate. `.github/pull_request_template.md` names
the same commands, so a pull request states which of them ran locally rather than leaving
the split to prose.

The image job is the newest and the one worth explaining. Everything above it measures the
source; none of it produces the artefact that actually deploys, so a broken `Dockerfile`
passed every gate and failed at Railway — where the failure reads as "Healthcheck failure"
and names nothing. That job builds the image cold, boots it, waits for `/api/health`, and
scans the result. Cold deliberately: a cached build here could go green while the build
Railway runs does not.

Enabling branch protection is a GitHub repo setting, not a file — Settings → Branches → Add
branch protection rule, pattern `master`, _Require status checks to pass before merging_
with **All checks** selected. That one name is the whole contract: `required` is an
aggregator that fails unless every job it needs reported success, so the list never has to
be re-edited when a job is added. It is the one manual step.

---

## Architecture

```
Browser ──── SSE ────► Next.js (single Railway service)
   ▲                        │
   │                        ├── HTTPS  ─► backboard.railway.com/graphql/v2   (mutations, queries)
   │                        └── WSS    ─► backboard.railway.com/graphql/v2   (log subscriptions)
   │
   └── Server Components render the container list; Server Actions mutate.
       The Railway access token never leaves the server.
```

One process, one deployment. Server Components read, Server Actions write, and a single
SSE route multiplexes deployment status and log output into the open tab.

| Path                                    | Role                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------- |
| `src/proxy.ts`                          | Refreshes the Railway access token before the render (see ADR-2)           |
| `src/lib/auth/`                         | OIDC flow, encrypted session cookie, refresh rotation                      |
| `src/lib/railway/`                      | GraphQL client, mappers, status model, ownership marker                    |
| `src/lib/railway/deployment-monitor.ts` | Merges status polling and the log subscription into one stream             |
| `src/app/layout.tsx`                    | The shell: one top bar and one footer, so a route owns only its column     |
| `src/lib/sse.ts`                        | SSE transport: framing, keepalive, duration ceiling                        |
| `src/lib/logger.ts`                     | Structured logs: request-scoped fields, the error serializer               |
| `src/lib/constants.ts`                  | Every tuned number, grouped by the concern that owns it                    |
| `src/app/tokens.css`                    | Design tokens — primitives, then the semantic layer the UI uses            |
| `src/components/ui/`                    | Primitives on Radix; features never hand-write a colour class              |
| `src/app/dashboard/`                    | Page, data loader, Server Actions                                          |
| `e2e/fixtures/fake-railway/`            | Stand-in Railway: OIDC + GraphQL + graphql-ws                              |
| `scripts/verify-schema.ts`              | Checks every operation against the committed schema; live too with a token |

---

## Limitations

- **GitHub-repo sources are not offered** (ADR-6). Supporting them means detecting
  whether the signed-in user's Railway account has the GitHub app installed, and sending
  them to install it — a real feature, not a line of code.
- **Private registries are not supported.** `serviceCreate` would need credentials this
  app does not collect.
- **A public address is a Railway hostname on one port, and nothing else.** A spin-up whose
  port field is filled in gets a `serviceDomain` — `spun-web-production.up.railway.app` —
  and a container that has none can be given one from its row. Three things that are not
  offered, each for its own reason:

  **Custom domains.** `customDomainCreate` exists, and using it would mean asking someone to
  place a CNAME this app cannot place, then reporting on a certificate issue it cannot
  observe. The control would succeed and the domain would appear broken for reasons living
  in someone else's DNS.

  **TCP proxies.** This is why redis, postgres and the rest are reachable from the project
  and nowhere else. `tcpProxyCreate` is the mutation, and it is `@deprecated` on the live
  schema — "use staged changes and apply them", plus a redeploy the caller has to perform
  itself before the proxy is active. Shipping the database presets' reachability on a
  retiring mutation is a worse trade than leaving them on Railway's private network, which
  is where a database usually belongs anyway.

  **A port for an image the catalog does not know, from the row.** `Preset.httpPort` carries
  the port for every image on the spin-up form, and the form's own field carries it for
  everything else — but the row control posts three ids and no port, deliberately, so that
  a request cannot aim a domain at a port of its choosing. For an unrecognised image it
  therefore omits `targetPort` and lets Railway infer one from the running deployment. That
  inference is undocumented. If it picks wrong, the fix is to destroy the container and spin
  it up again with the port filled in.

- **Resource controls are set once, when the container is created.** Region, replicas, CPU,
  memory, restart policy and start command are on the spin-up form, behind an Advanced
  disclosure. `ServiceCreateInput` accepts none of them, so they are two follow-up mutations —
  `serviceInstanceUpdate` for the settings and `serviceInstanceLimitsUpdate` for the size,
  which Railway splits because the second is gated by the plan behind the token. Both run
  before the deploy, and a refusal of either leaves the service created and un-deployed with
  its own sentence, on the same argument the volume step makes: a container running in a
  region nobody asked for is a container quietly not doing what the form said.

  **They cannot be changed here afterwards.** An edit form carrying them would post seven
  blank values for a service that is already running, and blank means "unset it" — so an edit
  path can only carry them once it reads the current values back off `ServiceInstance` first.

  **The CPU and memory ones are readable, though — from the metrics query rather than from
  the service.** Each expanded row reads "0.25 of 2 vCPU", and the denominator is
  `CPU_LIMIT`/`MEMORY_LIMIT_GB`, which arrive beside the usage in the same request. That is
  what Railway is _enforcing_, which is not always what the form asked for: the size mutation
  is gated by the plan behind the token, so a clamped request shows the clamped figure here —
  the more useful of the two numbers, and the only one with a bearing on the bill. The other
  five controls have no such route back and remain write-only.

- **Ports, healthchecks and app sleep are not on that panel.** The target port is on the form
  already, because it belongs to the public address rather than to sizing. The healthcheck
  path is deliberately absent and follows it: Railway probes the path against the service's
  target port, so a path set for a container with no address is a deployment that hangs in
  `DEPLOYING` and then fails, on a control this app offered. `sleepApplication` is excluded
  because a sleeping service makes three existing readouts lie — derived uptime, the
  CPU/memory snapshot, and the watcher's fingerprint, which sees no change and reports a
  healthy container that is not running. `drainingSeconds` and `overlapSeconds` are excluded
  because nothing here renders them and nobody could check they applied.

- **There is no entrypoint control, because there is no entrypoint member.**
  `ServiceInstanceUpdateInput` has `startCommand` and nothing else, so a start command
  replaces the image's CMD and its ENTRYPOINT still runs. Changing that means rebuilding the
  image.

- **Editing a container is a name, an image and its variables — nothing else.**
  `ServiceInstanceUpdateInput` carries twenty-odd other members. The six the spin-up form now
  sets are listed above and are create-time only; the rest — healthcheck, cron schedule, build
  and Nixpacks configuration, watch patterns, private-registry credentials — are untouched on
  both paths, and each is a feature with its own ticket rather than a field to pass through.
  Sending only `source` on an edit is what leaves every one of them alone.

  Two things about that mutation are worth writing down, because both cost time to find.
  **The name is not on it.** Railway splits a service in two — `Service` holds the name,
  `ServiceInstance` holds how it runs — so a rename is `serviceUpdate`, a second mutation
  entirely, and any plan that assumes `serviceInstanceUpdate` can rename is wrong before it
  starts. And **there is no `skipDeploys` member**, which `VariableCollectionUpsertInput` has:
  if Railway redeploys on a source change there is no way to ask it not to. So the edit issues
  its own `serviceInstanceDeployV2` afterwards and keys the row on the id that returns —
  the later deployment is the one being watched either way, at the cost of possibly causing
  two.

- **A partial edit is possible, and the list is what tells you.** The rename and the image
  change are separate calls; the first can land and the second be refused. Neither is rolled
  back — this app has no transaction to roll back into — so the refreshed row shows what
  actually applied rather than what was asked for. The alternative was reporting the whole
  edit as failed while half of it had happened, which is worse in the only way that matters.
- **Cost is a workspace figure, not this app's — and the form can now multiply it.** Replicas
  times vCPU times memory is the first thing this app lets anyone set that changes the bill,
  and it still cannot say by how much. The dashboard shows what the workspace a
  project belongs to has spent this billing period, and says so in the same sentence, because
  that is the only monetary number Railway exposes: `Customer.currentUsage` and
  `CustomerSubscription.nextInvoiceCurrentTotal`, both workspace-wide. `estimatedUsage`
  sounds like the answer and is not — asked against a real project it answered
  `CPU_USAGE: 1.27` and `MEMORY_USAGE_GB: 494.8`, magnitudes rather than money, and there is
  no dollar measurement anywhere in `MetricMeasurement`. So this app cannot tell you what the
  containers it created cost, only what the workspace they live in has spent, and the usage
  total beside the list is in vCPU and GB for exactly that reason. Three cases have no figure
  at all: a personal project, which belongs to no workspace; a token without
  `workspace:viewer`, which cannot read one; and `Customer` being withdrawn, which the
  `ProjectMetrics` document is now validated against the schema for — three types below a root
  field and no longer invisible, since `pnpm codegen` reads `customer { currentUsage
billingPeriod { start end } }` as part of the document. All three render a link to Railway's own billing
  page rather than a number this app would have to caveat further. The one record of what was
  asked for is the `container.created` log line, which carries the region, the replica count
  and the size — Railway keeps nothing once a service is destroyed. The per-row ceiling is
  the one figure here that is capacity rather than consumption, which is why the total under
  the list does not sum it: Railway bills measured usage, and "6 vCPU provisioned" beside a
  dollar amount would read as a claim about the bill that is not true.
- **Uptime is derived, and it counts the build.** There is no started-at anywhere in the
  schema, so it is measured from `latestDeployment.createdAt` — when the deployment was
  _queued_. For a Docker image source, which is all this app creates (ADR-6), that overstates
  by the few seconds of pull and boot. For anything slower it would overstate by more.
- **The readouts are a snapshot, not a graph.** One point per service per measurement, sized
  to the request budget rather than to what `Query.metrics` will return: a wider window and a
  faster `sampleRateSeconds` would give a sparkline at no extra _request_ cost but a much
  larger response, and the readout is deliberately the cheap half. Four measurements are
  asked for — two usage, two ceilings — which doubled the response and left the request count
  exactly where it was, because `measurements` is a variable on one document rather than a
  query per measurement. `Query.metrics` is in
  `DEGRADING_OPERATIONS`, so losing it costs the readouts and the usage total and nothing
  else — the row falls back to the same em dash it shows for a container with no samples yet.
- **Projects and environments can be created here but never deleted here.** `projectCreate`
  and `environmentCreate` have documents, which is what makes them dependencies;
  `projectDelete` and `environmentDelete` are absent from `operations.ts` entirely, so no
  request shape reaches them. This is not a
  gap waiting to be filled. Deleting a service is bounded — the `MANAGED_PREFIX` check means
  this app only ever deletes what it created, and what it created is one container. Deleting
  a project takes every service, environment and volume inside it, including the ones this
  app did not create and cannot see the value of, and no ownership marker on the project
  makes that safe: the blast radius is the contents, not the wrapper. So the prefix is not
  applied to them either — it gates destroy, and there is no destroy to gate. Removing a
  project is done in Railway's own dashboard, where the consequences are stated by the
  people who own the billing relationship.
- **A new environment is empty.** `environmentCreate` is sent with `skipInitialDeploys` and
  without `sourceEnvironmentId`, so nothing is copied in and nothing is deployed. Railway's
  own dashboard duplicates an existing environment instead; that is the more useful default
  for someone who has already set a project up, and the more expensive one to hand to a
  button whose consequences are not on screen.
- **Volumes are attached to the presets that need one, and to nothing else.** postgres,
  mysql, mariadb, mongo, redis and rabbitmq each carry a mount path in the catalog and get a
  volume before their first deploy — before, because a first deploy without the mount runs
  the image's own initialisation against the container filesystem and the next deploy mounts
  an empty volume over the top of it. An image the catalog does not know gets none, and the
  spin-up form says so: this app cannot guess where an arbitrary container writes, and a
  volume mounted at the wrong path is billable storage that stays empty while the data still
  vanishes. Four further caveats, none of them oversights. **Size is Railway's plan default**
  — `VolumeCreateInput` has no size member, so there is nothing to offer. **A mount path is
  fixed at creation**; `volumeInstanceUpdate` could change it and is deliberately absent, for
  the reason the edit form gives about images. **There are no backups and no
  point-in-time restore**, both of which Railway exposes and neither of which has a UI here.
  And **a volume is listed a few seconds after it is created** — about three, measured, on
  `environment.volumeInstances` — so a container destroyed inside that window keeps its
  volume. That is the cautious outcome and the toast says so, which is the property
  [ADR-14](docs/adr/0014-a-volume-belongs-to-the-service-that-mounts-it.md) rests on: every
  way of not knowing about a volume ends in keeping it and saying it was kept.
- **Environment variables are single-line, and capped.** Twenty-five rows, 2 048 characters
  a value, 16 000 characters in total, and no line breaks — so a certificate, a private key
  or a JSON document is set on Railway's own Variables page rather than here. Names in the
  `RAILWAY_*` namespace are refused, because Railway sets those itself.
- **An existing container's variables are edited by name, never by value.** The edit form
  lists what a service has and leaves every value cell empty: a stored value — minted or
  typed — is filtered out server-side and reaches no browser, so blank is what an untouched
  row looks like and the server reads it as "leave this one alone". Retyping a cell replaces
  that variable; removing the row deletes it, one key at a time rather than by replacing the
  collection. Shared variables the environment sets for every service are not listed, because
  they are not this service's to change. The consequence worth stating: there is no way to
  read a value back here, and Railway's own Variables page is still where you go for that.
- **Image existence is checked, advisory only, and only on three registries.** A
  well-formed reference used to be accepted whatever it named, so `nonexistent/image:tag`
  became a failed deployment with nothing on screen connecting it to the typo. The form now
  asks Docker Hub, ghcr.io or quay.io for the manifest as the field settles, and warns
  beside it — a warning, not a validation error: nothing is refused, `aria-invalid` is not
  set, and the submit button stays live.

  This was refused twice before on two grounds, and both were right about the naive
  version. The first was an SSRF that did not exist yet: `IMAGE_PATTERN` admits a bare host
  as the first component, and Docker's own rules make a first component containing a dot a
  registry, so `169.254.169.254/foo/bar` is a valid reference and dereferencing user input
  would reach cloud metadata. What closes it is refusing rather than resolving — three
  registries with their base _and_ token URLs as compile-time constants in
  `src/lib/registry/registries.ts`, no `WWW-Authenticate` realm ever followed, and
  `redirect: "manual"` so a registry cannot choose a URL either. Nothing derived from user
  input is ever a host, a port or a scheme; a reference naming anything else is parsed,
  reported as unsupported, and never dereferenced.

  The second was shared egress, and that one turns out to have been about the wrong verb. A
  manifest `HEAD` does **not** consume Docker Hub's anonymous pull budget and a `GET` does —
  measured against `library/redis:7-alpine`, where two `HEAD`s left `ratelimit-remaining` at
  `100;w=3600` and a `GET` took it to 99. The check is `HEAD` only. The cache, the
  per-registry cool-off after a 429 and the per-user concurrency cap are insurance against
  the request rate underneath that published budget, not against the budget itself, and a
  preset is never checked at all — the catalog exists by construction, and it is the field's
  default value.

  **What it still does not catch**, which is most things: architecture mismatches, images
  that need credentials, a tag deleted between the check and the deploy, and any registry
  outside those three. A registry that is rate-limiting, timing out or down produces
  `unknown`, which renders nothing — a check that could stop a spin-up would be worse than
  the failed deployment it is warning about. And on all three registries, "no such
  repository" and "private repository" are the same 401 or 403 with no way to tell them
  apart anonymously, so one sentence covers both. That is honest rather than vague: this app
  collects no registry credentials, so a private image fails to deploy exactly as an absent
  one does.

- **A failed deployment's reason is best effort, and Railway's page is still the fallback.**
  The deployment query returns a status and nothing else, so a failure reaches the poll loop
  as the enum `FAILED`; the `Deployment` type carries no explanation at all, and `diagnosis`
  and `meta` are opaque `SCALAR`s with no documented shape. The reason lives on
  `deploymentEvents`, which the monitor reads **once**, on the terminal-failed transition, as
  its own document — never from the status poll, which runs for the life of every open stream
  and would turn a withdrawn field into a schema rejection the monitor treats as transient
  and now backs off from, so the silence would last the full duration ceiling and be quieter
  than before. `DeploymentEvents` is in `DEGRADING_OPERATIONS`, so `pnpm verify:schema` reports
  its withdrawal without failing, and a row whose feed is empty, refused or withdrawn shows
  exactly what it showed before: the status, the sentence, and the link out. Two things stay
  unresolved. Which of `payload.error`, `payload.reason` and `payload.detail` Railway actually
  populates has never been observed on a real failed deployment — the schema was introspected,
  not the behaviour — so the app tries all three newest-event-first and `pnpm probe:deployment
<id>` settles it. And the reason arrives on **expand**, not on page load: the stream only
  opens for a settled container once its panel is open, and fetching per failed row at render
  time is the cost profile the whole streaming design exists to avoid.

  The third used to be that verification could not see a withdrawn member of
  `DeploymentEventPayload`, two types below the root field. It can now: the document itself is
  validated against Railway's schema, `payload { error reason detail skipped }` included, and
  `pnpm codegen` refuses to generate a type for a selection Railway no longer offers.

- **A container can be stopped, restarted, redeployed, rolled back and destroyed.** Stop is
  `deploymentStop`, restart is `deploymentRestart`, rollback is `deploymentRollback`, and
  redeploy is `serviceInstanceDeployV2` rather than the obvious `deploymentRedeploy`: that
  one takes a deployment id, and a service whose first deploy Railway refused has none —
  which is exactly the row most in need of the control. The four reversible verbs confirm
  with a sentence and two buttons rather than the destroy dialog's typed name — friction is
  priced in what it protects. What "spin up" does to a stopped service is nothing: it
  creates, the duplicate-name check refuses a second container by that name, and the row's
  own **Redeploy** is the way back.

  `deploymentRemove` is the one lifecycle call still in `OPTIONAL_FIELDS`, reported by
  `verify:schema` and sent by nothing: it erases a stopped deployment's record, which is the
  one thing it destroys that `serviceDelete` does not already take.

- **Rolling back names a time, not an image — because Railway will not say what a deployment
  ran.** This entry used to read "rollback needs a UI for choosing which deployment to go
  back to, over image tags the user cannot see here", and half of that is still true.
  `Deployment.meta` is an opaque `SCALAR` like `diagnosis`, so no request this app can make
  will tell it which image a past deployment used. What the app _can_ read is
  `createdAt`, `status` and `canRollback` — enough for "the deployment from 14:32 that
  succeeded", which is a choice a person can make. So an expanded row on a managed container
  lists its recent deployments, marks the one running now, and offers a rollback on each
  entry Railway itself says it would accept. An entry it says no to is shown without a
  control rather than left out, because the deployment that broke things is usually beside
  the one someone is looking for.

  Three things worth knowing about how it is wired:

  **The list comes from `Query.deployments`,** not `service.deployments` or
  `project.deployments` — both are `@deprecated` in favour of `environment.deployments`,
  which takes pagination only and cannot be narrowed to one service. The root field takes
  `DeploymentListInput` and is the only one of the four that answers for a single service in
  a single request. It is read when a panel is opened, never with the list, on the same cost
  argument the variables read makes: twenty rows would otherwise be twenty requests for
  panels nobody has opened.

  **It is the one request in this app that posts a deployment id.** Every other lifecycle
  verb reads that id off the container the ownership guard just re-derived from Railway's own
  answer; a rollback target is by definition in the past, so there is nothing current to read
  it from. What replaces the derivation is the same shape destroy uses for a volume: the
  action re-reads the deployment list, scoped by the service id Railway returned rather than
  the one posted, and refuses any id that is not a member of it with `canRollback` set. The
  list read is in `DEGRADING_OPERATIONS`, so a refusal yields an empty list — and an empty
  list contains nothing, which is the direction this has to fail in.

  **Whether a rollback mints a new deployment id is unobserved, and nothing depends on it.**
  `deploymentRollback` answers a Boolean, so the response says nothing, and finding out would
  mean performing a real rollback on a real account — every probe here is read-only. The row
  re-reads the container list afterwards and re-keys its log stream on whatever id comes
  back, exactly as it does after a redeploy, so both behaviours look the same from here. The
  e2e fixture mints a new one deliberately, because that is the case the browser has to
  notice. `pnpm probe:deployments` settles the questions that _are_ answerable read-only:
  whether a delegated OAuth grant may call the field at all, which order the edges arrive in,
  and what `canRollback` answers for a running deployment versus a finished one.

- **SSE pins a client to one replica**, so this is a single-replica app today. Two pieces
  of module state say so out loud: the stream cap in `lib/stream-slots.ts` and the
  idempotency map in `lib/idempotency.ts`. See below.
- **A stream open to its ceiling** outlives nothing: `STREAM.MAX_DURATION_MS` is fifteen minutes, clamped further to whatever is left of the access token. Deploys finish well
  inside that; a long-lived streaming session would need mid-stream token rotation.
- **Double-submit protection expires, and does not survive a restart.** A submission
  carries an idempotency key and a repeat of it is answered with the first one's result
  rather than a second container (ADR-12), but that entry is held in memory for
  `IDEMPOTENCY.RETAIN_SECONDS` on one replica. A repeat after that window, or across a
  deploy that lands between the two halves of a double submit, still creates two services.
  Both windows are far narrower than the name check this replaced, which was not a lock at
  all.
- **The duplicate-name message is stale by design.** It moved into the browser, where it
  is checked against the list the page has already loaded, so it costs nothing — and it
  cannot see a container created a second ago in another tab. It is a typo guard; the
  idempotency key is the part that is load-bearing. The ownership re-derivation in
  `spinDown` is a genuine safety property and stays (ADR-5).
- **No `nonce` in the OIDC flow** (ADR-1) — `state` and PKCE only. Defensible with
  `response_type=code` plus PKCE `S256`, since the code is bound to the verifier and the
  id_token is never accepted from a redirect, but it is a deviation from the OIDC core
  recommendation and worth stating rather than leaving to be discovered.
- **Sign-out is local only, because Railway offers nothing else.** It deletes the session
  cookie, and the grant stays live at Railway until it expires or the user removes the
  app. That is not a call this app declined to make: the discovery document publishes no
  `revocation_endpoint` and no `end_session_endpoint`, and the paths a provider of this
  shape would put them on — `/oauth/token/revocation`, `/oauth/revoke`,
  `/oauth/revocation`, `/oauth/session/end`, `/oauth/logout` — all answer 404 to a POST
  that `/oauth/token` answers with `invalid_request`. So the sign-out notice on the
  landing page says both halves of what happened and points at Railway's account
  settings, which is where the authorization is actually removed, and `verify:schema`
  asserts both endpoints are still absent on every push — when one appears, CI goes red
  and this entry is wrong. The standing cost is in `src/lib/auth/refresh.ts`: a
  refresh token is abandoned rather than revoked on each sign-out, against a cap of 100
  live tokens per authorization.
- **A project switch announces once, at the start.** `useTransition`'s pending state now
  ends when the skeleton commits rather than when the containers arrive, so the polite
  "Loading containers…" fires as the wait begins and the skeleton carries the rest. A
  live region that stayed accurate for the whole wait would cost a client provider to
  extend an announcement already delivered.

---

## What I would do next

- **Scale-out:** extract a WebSocket gateway service with Redis pub/sub, holding one
  upstream subscription per deployment and fanning out to N viewers, instead of one
  upstream connection per viewer per replica. That is what SSE's replica affinity forces
  once there is more than one instance.
- **An audit log** of spin-up/spin-down per user — now half done. The events are recorded
  (`container.created`, `container.create_failed`, `container.create_replayed`,
  `container.destroyed`, `container.stopped`, `container.restarted`,
  `container.redeployed` and a `…_refused` per verb, with the
  subject and the ids), and the field set is deliberately the shape a table would take, so
  the remaining work is a parse rather than a re-instrumentation. What a database adds is
  retention beyond the log window and a query the user can run themselves.
- **A sparkline per row, and a per-container cost estimate.** The first is a wider
  `startDate` and a faster sample rate on a query the app already sends — a response-size
  decision rather than a request-budget one. The second is arithmetic over `Query.usage` and
  Railway's published unit prices, which would make it _this app's_ estimate of a number
  Railway does not publish per project, and it would have to be labelled as such everywhere it
  appeared. Both are wanted; neither should arrive quietly.
- **Ship the logs somewhere.** ADR-9 cut the seam and left it unused: add the OTel
  packages, add `register()` to `src/instrumentation.ts`, point Grafana Alloy at Railway's
  log drain. Nothing in `src/**` outside that one file should need to change — that is the
  test of whether the seam was cut in the right place.
- **Move off the two deprecated reads**, which the deprecation report in `pnpm verify:schema`
  named as soon as it existed. `User.projects` is marked _"This field will not return anything
  anymore, go through the workspace's projects"_ and `Service.serviceInstances` is marked
  _"Use environment.serviceInstances for properly scoped access control"_ — the personal
  project source and the container list, so the two most important reads in the app. Both
  still answer, which is why this is a plan rather than a bug. It is also a candidate
  explanation for the empty-project-list case documented above, and the reason to do it before
  Railway makes the decision for us.
- **Budget guards:** a per-user cap on concurrent containers, and a TTL that reaps them
  automatically — the obvious next thing for a tool whose whole purpose is creating
  billable infrastructure.

---

## Verifying it works

1. Sign in. Railway's consent screen should list your projects — select at least one.
2. Spin up `redis:7-alpine`. The row should move Queued → Building → Deploying →
   Running, with build output streaming in the expanded log pane.
3. **Stop it.** The badge should settle at **Removed** while the row stays on the
   dashboard — the service, its variables and its history are all still on Railway. The
   row's controls change with it: Stop and Restart give way to Redeploy. Press that and it
   should come back Queued → Building → Deploying → Running. Then press **Restart** on the
   running container with its log pane open: the pane keeps filling, because a restart
   keeps the same deployment rather than starting a new one.
4. Destroy it (type the container name to confirm) and check it disappears from the
   Railway dashboard too.
5. **Several at once.** Spin up three, tick their checkboxes and press **Destroy
   selected**. The confirmation names the count and lists the names, and asks for the
   count rather than three names — friction proportionate to the batch instead of
   multiplied by it. Ownership is still re-derived per service on the server: the
   unmanaged row has no checkbox, and `actions.integration.test.ts` proves a forged
   service id in a batch is refused on its own while the rest go through.
6. **Sorting.** Change **Sort** and confirm the URL gains `?sort=`, the order changes with
   no request to Railway, and reloading the page keeps it. Then press **Clear filters**:
   the search and status params go and the sort stays, because it hides nothing and has
   its own default.
7. **Token expiry:** leave the tab open past the hour, or rewind `expiresAt` in the
   session cookie, then perform an action. It should succeed — the proxy refreshes and
   rotates transparently.
8. **Ownership:** create a service in the Railway dashboard directly. It appears here as
   _Not managed here_, with no lifecycle controls at all — no stop, restart, redeploy or
   destroy, and no selection checkbox either.
9. **The way out:** click any container's name — every row, not only the broken ones —
   and confirm it opens that service on Railway in a new tab. The chevron beside it is
   the log panel's disclosure; check it still expands from the keyboard.
10. **Failure paths:** type `nonexistent/image:tag` and confirm the field warns beside it
    after a beat — then confirm the warning changes nothing else: the field is not marked
    invalid, the submit button is live, and submitting still creates the container. That is
    the whole point of the check being advisory. It settles into **Failed** rather than
    spinning forever, and expanding the row explains the failure and repeats **Open in
    Railway**. Do not expect build logs here: an image source
    performs no build, and a pull that never resolves may write nothing to either log
    phase — which is exactly why the row carries an explanation and a deep link. Reload the
    page and expand the row again; if Railway did write output to the other phase, the
    monitor's fallback fetches it. Then revoke the app's authorization mid-session and
    confirm you are sent back to sign in with an explanation, not a stack trace.

---

## Decisions

Fourteen decisions, argued in full in [`docs/adr/`](docs/adr/README.md). The short
version of each:

| #                                                                         | Decision                                                                  | Why it matters                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [ADR-1](docs/adr/0001-railway-oidc-directly-not-an-auth-vendor.md)        | Railway OIDC directly, not an auth vendor                                 | The app acts on **the visitor's** Railway account, not on a token I own — that makes auth a capability-delegation problem, not a login problem, and Railway is itself a compliant OIDC provider                                                                   |
| [ADR-2](docs/adr/0002-token-refresh-runs-in-the-proxy-layer.md)           | Token refresh runs in the proxy layer                                     | Access tokens live one hour and refresh tokens rotate on every use; Server Components can read cookies but not write them, so refresh runs in `src/proxy.ts` before the render                                                                                    |
| [ADR-3](docs/adr/0003-sse-downstream-websocket-upstream.md)               | SSE downstream, WebSocket upstream                                        | Railway genuinely pushes log lines over GraphQL subscriptions, but App Router route handlers cannot accept WebSocket upgrades and the data only flows one way                                                                                                     |
| [ADR-4](docs/adr/0004-no-database.md)                                     | No database                                                               | Railway holds the state; mirroring it would only create drift                                                                                                                                                                                                     |
| [ADR-5](docs/adr/0005-the-app-only-destroys-what-it-created.md)           | The app only destroys what it created                                     | This tool changes infrastructure, so ownership is the load-bearing safety property — the `spun-` name prefix is the marker, re-derived server-side before every destroy, stop, restart and redeploy                                                               |
| [ADR-6](docs/adr/0006-docker-images-only.md)                              | Docker images only; GitHub sources are a stated limitation                | Repo sources silently require _the signed-in user's_ Railway account to have the GitHub app installed with access to that repo — something this app cannot provision on their behalf                                                                              |
| [ADR-7](docs/adr/0007-the-url-is-the-state.md)                            | The URL is the state; there is no client store                            | Project, environment and filters are search params, so the dashboard is linkable and the server does the fetching; there is no client fetch, so there is no client cache to reconcile                                                                             |
| [ADR-8](docs/adr/0008-a-hand-rolled-graphql-client-not-apollo.md)         | A hand-rolled GraphQL client, not Apollo                                  | All of `src/lib/railway/` is server-only, so Apollo's normalized cache and browser hooks have nothing to attach to — and a cache would be actively wrong for a live view of infrastructure                                                                        |
| [ADR-9](docs/adr/0009-structured-logs-on-stdout.md)                       | Structured logs on stdout, with the OTel seam cut but not used            | The whole server used to log through one `console.error` that flattened everything a query would want — kind, status, operation, incident id — into a template string only `grep` could read                                                                      |
| [ADR-10](docs/adr/0010-the-dashboard-watches.md)                          | The dashboard watches; it does not poll from the browser                  | A container created or destroyed in Railway's own dashboard did not appear here until someone pressed Refresh, and Railway publishes no project subscription — so someone has to poll, and the server does                                                        |
| [ADR-11](docs/adr/0011-pnpm-stays.md)                                     | pnpm stays, and the migration was priced rather than assumed              | npm has no equivalent of `allowBuilds`, a per-package postinstall allowlist, and `pnpm audit --prod` re-evaluates reachability where an ignore-list of advisory ids decays                                                                                        |
| [ADR-12](docs/adr/0012-idempotency-keys-replay-rather-than-reject.md)     | Idempotency keys on create, and a repeat is replayed rather than rejected | A name check is not a lock and cost a round trip before every create; a repeat now gets the first submission's answer, because "you already submitted this" is a false statement about a container that exists                                                    |
| [ADR-13](docs/adr/0013-the-origin-is-the-request-not-a-variable.md)       | The origin is the request, not a variable                                 | One configured origin meant one working domain: a custom domain sent sign-in to the generated `*.up.railway.app` one. The origin is now derived per request from the forwarded host, validated, and https unless loopback                                         |
| [ADR-14](docs/adr/0014-a-volume-belongs-to-the-service-that-mounts-it.md) | A volume belongs to the service that mounts it                            | Six presets kept state on a filesystem thrown away with the container. Railway does not cascade a delete to the volume, so destroy asks — box checked — and names the outcome either way; the ownership gate is the service's prefix, never the volume's own name |

---

## Tests

Four tiers, each answering something the others cannot.

| Tier            | Runs on     | Covers                                                            |
| --------------- | ----------- | ----------------------------------------------------------------- |
| **unit**        | node        | Token rotation, status mapping, ownership, backoff, SSE framing   |
| **component**   | jsdom + RTL | Dialog guard, stream hook, autoscroll, keyboard on the primitives |
| **integration** | node + MSW  | Server Actions and route handlers against a mocked Railway        |
| **e2e**         | Playwright  | The real OAuth flow and lifecycle against a fake Railway          |

`pnpm test:coverage` gates on **how many lines, branches, functions and statements are
not covered** rather than on a percentage, across `src/**`, with per-directory budgets for
`src/lib`, `src/hooks`, `src/features` and `src/components` on top, and one file-level
floor at 100 for `src/lib/railway/subscribe.ts`. A count is stable when the denominator
moves, which a percentage is not — see
[`.ai/rules/testing.md`](.ai/rules/testing.md), which has the reasoning, and
`vitest.config.mts`, which is where the numbers are maintained. They are not restated here,
because the copy that was here said 98/91/98/96 against a config that read 98/90/97/96: the
figures it quoted were the _measured_ ones, not the enforced ones. Framework shells (`page.tsx`, `layout.tsx`, `loading.tsx`, `error.tsx`)
are excluded and covered end-to-end instead — counting them would either inflate the
number or invite render tests that assert nothing. E2E does not feed the figure, so
component tests have to carry the UI.

Log records are asserted, not printed past. `src/test/log-capture.ts` is installed
globally from `src/test/setup.ts`, so every tier can read what was actually written —
including the credential canary, which runs over the real OAuth callback handler and
searches the raw serialized bytes rather than a parsed record.

**One spec runs at phone width, not the whole suite.** `playwright.config.ts` declares a
second `mobile` project scoped by `testMatch` to `e2e/responsive.spec.ts`. `workers: 1`
is not negotiable — the fixture holds shared state — so a second full project would
roughly double CI wall-clock, and the app reaches for `sm:` four times in all of `src/` and adapts
by wrapping everywhere else, leaving no viewport-conditional code to regress. What a
phone viewport genuinely proves is what that spec asserts: nothing overflows sideways
with the list filtered and paged, the nine status chips wrap rather than clip, the search
field takes the line, and the back-to-top button does not cover the last row's controls.

One deliberate split: the sign-in button's busy state is a component test, not an e2e
one. It exists only between the click and the browser committing the next document, and
against the fixture that whole OAuth chain finishes in under 120ms — while forcing a
window open, by holding or aborting the request, makes Chrome tear down the document and
destroy the state under test.

### The fake Railway

`e2e/fixtures/fake-railway/` is a stand-in Railway on one port: an OIDC provider whose
`id_token` is genuinely RS256-signed and served through a real JWKS, a GraphQL API over
an in-memory store, and a hand-rolled `graphql-transport-ws` endpoint. Deployments
advance `QUEUED → BUILDING → DEPLOYING → SUCCESS` on a timer, so status transitions and
log streaming are real rather than snapshots.

The app runs unmodified against it — `RAILWAY_ISSUER` / `RAILWAY_API_URL` /
`RAILWAY_WS_URL` are the only difference — so PKCE, the token exchange and refresh-token
rotation are all exercised, rather than stubbed away by seeding a session cookie.
`POST /__test/faults` injects rate limits, revoked authorizations, failed builds and a
`slowMs` delay — busy state only exists while a request is in flight, so a spec that
means to assert on it slows the API down rather than racing it.

Playwright runs `workers: 1`: the fixture holds shared state that each spec resets.

### Known non-issues

**"The resource … was preloaded using link preload but not used within a few seconds
from the window's load event."** Development only, and not this app's. `next dev` emits
exactly one `<link rel=preload>`, and it is Turbopack's HMR client — which the dev
runtime loads through its own machinery rather than as a plain script, so the browser
reports it unused. A production build emits one preload (Next's error-boundary chunk, at
`fetchPriority=low`) and the browser does not complain about that one at all.

`e2e/console.spec.ts` asserts this rather than assuming it: it captures the console over
CDP — `page.on("console")` never receives engine-generated messages like this one — with
an empty allow-list, so any _new_ warning fails CI.

---

## Design system

Tokens live in `src/app/tokens.css` in two layers: raw ramps, then a semantic layer
(`--rc-canvas`, `--rc-text-muted`, `--rc-state-running`, …) which is the only thing the
UI is allowed to touch. `@theme inline` in `globals.css` maps the semantic layer onto
Tailwind utilities.

> The semantic tokens are named `--rc-*`, not `--color-*`. Mapping `--color-accent:
var(--color-accent)` is self-referential: Tailwind resolves it to whatever `:root`
> happens to hold, and the theme overrides silently stop applying — the dashboard
> rendered light-theme accents inside dark mode until the namespaces were separated.

Dark is the default, matching Railway's product; light follows `prefers-color-scheme`;
an explicit `[data-theme]` beats both, in either direction. Container-state colours are
resolved through a `data-state-color` attribute, so adding a state means adding a token
rather than editing a lookup table inside a badge.

Primitives in `src/components/ui/` are built on Radix. That buys real behaviour, not
styling: the destroy confirmation gets a focus trap, Escape handling and focus restore;
action feedback moves to an announced toast region; the raw Railway status enum moves
out of a `title` attribute, where keyboard and screen-reader users never saw it.

Appearance is enforced, not just documented. ESLint rejects raw palette utilities
(`bg-emerald-500/10`), hex literals and `[var(--…)]` arbitrary values in any `className`
outside `src/components/ui/**`, because each of those bypasses the semantic layer and
with it the light theme and the contrast test.

### Typography

The type scale is seven roles, not a set of sizes: `display`, `title`, `heading`, `body`,
`label`, `caption`, `mono` — plus `badge`, which is a `Text` variant sharing the caption
size rather than a scale step with a token of its own. Sizes and line-heights live in `tokens.css` and are
mapped into Tailwind as `text-<role>` utilities; the `Text` and `Heading` primitives in
`src/components/ui/text.tsx` are the only place a weight is chosen.

Naming them by role rather than size is the point. `text-sm font-medium` says nothing
about whether the next component should match it, and the app had accumulated four
different spellings of "heading" across five files, two page-level `h1`s ten pixels and a
weight apart, and a log pane whose rows carried a line-height its own skeleton did not.

Four files have to agree for a step to work, and three of the failures are silent:

| File           | What it holds                        | If it is missing                               |
| -------------- | ------------------------------------ | ---------------------------------------------- |
| `tokens.css`   | `--type-<role>-size` / `-height`     | the mapping resolves to nothing                |
| `globals.css`  | the `--text-<role>` `@theme` mapping | Tailwind generates no rule; the class is inert |
| `ui/text.tsx`  | the variant and its weight           | the role is unreachable                        |
| `lib/utils.ts` | `TYPE_SCALE` for tailwind-merge      | the class is read as a _colour_ and dropped    |

That last one is the nastiest: out of the box tailwind-merge only knows Tailwind's own
`text-xs … text-9xl`, so an unrecognised `text-caption` is classified as a text colour
and silently removed wherever it shares a `cn()` call with one. `src/app/type-scale.test.ts`
asserts all four agree, and `src/lib/utils.test.ts` pins the merge behaviour directly.

Like the colour layer, this is enforced rather than documented: `no-restricted-syntax` in
`eslint.config.mjs` rejects a raw `text-sm`, `font-medium`, `tracking-*` or `leading-*` in
any component outside `src/components/ui/**`.

### Busy state

`Button` owns it: `pending` blocks activation, renders a spinner and sets `aria-busy`,
and `pendingLabel` swaps the text. Two details are load-bearing:

- **`disabled` does nothing to a link.** Under `asChild` the primitive renders through
  Radix `Slot`, and a slotted `<a>` ignores `disabled` entirely — it neither dims nor
  stops responding to Enter. The primitive uses `aria-disabled` and cancels the click
  instead, so no caller has to remember. It stays focusable: moving focus to `<body>`
  mid-action is worse than a focused control that declines to act.
- **The label swap is silent.** Assistive tech does not re-read the accessible name of
  the element it is already on, so progress goes through `PendingStatus`, a live region
  that stays mounted while idle — mounting the region and its text together is the
  classic way to have an announcement dropped.

Controls that hand the page to the browser (sign in, sign out, re-authorize) are full
document navigations, so `useFormStatus` and `useTransition` see nothing. They use
`useNavigationPending`, which raises the flag on activation and clears it on `pageshow`
— otherwise returning via bfcache, after declining Railway's consent screen, restores a
button that spins forever.

### Loading states

Every wait a user can cause now shows something, and which mechanism applies depends on
what the wait replaces.

**Skeletons stand in for content that is about to appear.** The compositions live in
`src/components/dashboard-skeletons.tsx` and are shared by the route-level
`loading.tsx` and the in-page Suspense fallback, so a placeholder row is defined once.
Two rules there are load-bearing and have tests:

- **They are synchronous and take their strings as props.** A Suspense fallback must not
  suspend; an `async` composition awaiting `getTranslations()` would escalate past its
  own boundary and blank the whole route instead of one section.
- **The container fallback renders no `<ul>`.** The e2e helpers find the list by
  `getByRole("list", { name: "Containers" })` and assert there is exactly one.

**The one thing that no longer needs a skeleton is the top bar.** It used to have one,
and keeping it pixel-identical to the real header was a standing obligation enforced by
an exact `boundingBox` comparison. `AppHeader` now renders in the root layout, above
every route's loading boundary, so the same element survives the transition and there is
nothing to stand in for. That test is still there — it guards the placement decision
instead, and passes by construction rather than by two class strings agreeing.

**The container list sits behind a keyed Suspense boundary.** `page.tsx` awaits only the
shell — identity, projects, the resolved selection — and `ContainerSection` awaits the
second Railway round trip on its own. The `key` is the selection, and it is on
`<Suspense>` rather than on the child, because React only reveals a fallback for a
boundary it is _mounting_: an update to a boundary already showing content suspends
without committing, which is precisely why switching project used to hold the previous
project's rows on screen for the whole fetch. Keying the child compiles, renders and
reviews identically while restoring the bug, so `e2e/skeleton.spec.ts` asserts the old
rows are gone rather than only that the skeleton appeared.

The same property means `router.refresh()` — same key — never blanks a list the user is
reading. Those call sites carry their own pending state instead: spin-up and destroy
wrap the refresh in `useTransition` so the control that caused it stays busy, and the
destroy trigger is inert until the refreshed list lands, closing a window in which it
could be clicked again against a service that no longer existed. The settle-refresh in
`container-row.tsx` deliberately has none — nobody activated it, several rows can settle
at once, and the badge has already updated from the stream.

**The placeholder fill is a token, not an animation.** `globals.css` freezes every
animation under `prefers-reduced-motion`, so `--rc-subtle` at ~1.05:1 was an invisible
rectangle for those users. `--rc-skeleton` sits at ~1.5:1 dark / ~1.45:1 light,
asserted in `contrast.test.ts`, and the pulse is `motion-safe:` — an enhancement, not
the signal. The mid-load axe scan runs with reduced motion forced, which is exactly the
state the token exists for.

---

## Internationalisation

Every user-facing string lives in `messages/en.json`. Components read it through
next-intl: `getTranslations` on the server, `useTranslations` on the client.

There is one locale, and that is a stopping point rather than an unfinished job — adding
a second is a translation task, not a refactor. Three things make that claim real rather
than aspirational:

- **`no-literal-string` (eslint-plugin-i18next)** on `src/**/*.tsx`. A hardcoded sentence
  fails the build. Without it the catalog decays on the next commit.
- **Typed keys.** `global.d.ts` declares the catalog as next-intl's `Messages`, so
  `t("dashboard.emptyTitle")` is checked by `tsc`. A renamed key breaks the build
  instead of rendering a missing-message marker.
- **Tests assert real copy.** The Vitest setup swaps next-intl's hooks for its own
  `createTranslator` over the actual `en.json`, so a misnamed ICU argument or a malformed
  plural fails a component test. A key-echoing stub would have hidden all of it.

Code that has no request scope — error classes, the log monitor — returns a
`MessageDescriptor` (`{ key, values }`) instead of a sentence, and the layer that renders
resolves it. That is what keeps a Railway failure one catalog key rather than English
frozen inside a `throw`.

Some cases needed more than a placeholder: `{managed} of {total} created here` is an ICU
plural, the managed-prefix note is rich text with a `<code>` chunk that translators can
move, and `relativeTime` now uses `Intl.RelativeTimeFormat` — the previous `${n}s ago`
was plural-blind and assumed the marker was a suffix, which it is not in German.

---

## Performance

Next 16 stopped printing route sizes, so `pnpm size` reads
`.next/diagnostics/route-bundle-stats.json`, gzips each chunk a route loads first, and
compares against `bundle-budgets.json`. Per route, no browser, ~2 seconds. (size-limit
cannot express this: Turbopack hashes every chunk name, so its config could only hold
globs, and a glob sums a directory instead of answering "what does /dashboard cost".)

Budgets: **/dashboard 229 kB**, **/ 179 kB**, **/\_not-found 171 kB** gzipped, each a point or two above its last measurement — `bundle-budgets.json` is where they live and every raise carries its reason in the `$comment` log. The
404 pays for the shared top bar — `ThemeToggle` is a client component, so every route
now carries Radix ToggleGroup — which is the trade recorded in `bundle-budgets.json`.

Two changes moved those numbers, and one that looked obvious did not:

- `ToastProvider` moved from the root layout to `dashboard/layout.tsx`. The landing page
  and the 404 were shipping Radix Toast — ~12 kB gzip — to render UI with no actions.
- The log pane is `next/dynamic`. It only mounts once a row is expanded, and it brings
  Radix ScrollArea with it.
- **Lazy-loading the destroy dialog's body was reverted.** It saved ~10 kB on paper, but
  Radix traps focus in whatever the dialog contains when it opens — and for the tick
  before the chunk arrived, that was nothing, so Tab walked straight out into the page
  behind. `e2e/keyboard.spec.ts` caught it. Removing the `next/dynamic` wrapper also made
  the route _smaller_, because the wrapper cost more than the split saved.

Lighthouse CI covers what a byte count cannot — fonts, CSS, and the rendered result — on
the landing page **and the authenticated dashboard**, which `scripts/lh-auth.ts` reaches
by driving the real OAuth flow against the fake Railway with Playwright. Accessibility is
gated at 100; the performance _score_ is a warning, because it swings on shared CI runners
and a gate that flakes is a gate everyone learns to ignore. The resource budgets beside it
are deterministic, so they gate hard.

`numberOfRuns` is 1. One Chrome, never a pool.

---

## Accessibility

WCAG 2.1 AA, checked three ways because each misses what the others catch:

1. **`@axe-core/playwright`** on every meaningful state — landing, dashboard populated
   and empty, destroy dialog, log panel, form errors — **in both themes**.
2. **`src/app/contrast.test.ts`** parses `tokens.css` and computes the contrast ratio of
   every declared pair in both themes. It runs in milliseconds without a browser and
   covers colours no spec happens to visit; it is what makes promising two themes safe.
   It has already caught four real failures.
3. **Keyboard specs** (`e2e/keyboard.spec.ts`) for focus traps, focus restore, roving
   tabindex, Escape and live-region politeness. Axe cannot see any of that — and they
   are what make replacing a native `<select>` with a Radix one defensible.

Axe misses more than timing. The unmanaged-container control passed every scan while
showing "Not managed here" under an accessible name of "Why can't postgres be
destroyed?" — no shared words, so voice control could not address the thing on screen
(WCAG 2.5.3 Label in Name). Nothing automated flagged it.

Plus `eslint-plugin-jsx-a11y` at strict, with CI failing on any warning.

---

## Logs

One JSON object per line on stdout, which is what Railway captures. Locally,
`pnpm dev:pretty` pipes it through `pino-pretty` — a devDependency and a pipe, never a
pino _transport_, because a transport runs in a worker thread and that is precisely the
thing Next externalizes pino to work around.

```
{"level":"info","time":1786543673062,"service":"container-console","env":"production",
 "version":"9f7f505","request_id":"a1b2c3d4e5f60718","subject_id":"user_42",
 "route":"spinUp","project_id":"p_1","environment_id":"e_1",
 "service_name":"spun-api","image":"nginx:1.27","service_id":"svc_9",
 "msg":"container.created"}
```

| Field                       | What it is                                                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `msg`                       | The event name. Around sixty stable values — the field to build a Loki label on                                      |
| `level`, `time`             | String label, epoch ms. Both pino defaults, left alone so the OTel bridge reads them                                 |
| `service`, `env`, `version` | Map onto OTel's `service.name` / `deployment.environment.name` / `service.version`                                   |
| `request_id`                | Joins a proxy line to the render and stream lines that follow it                                                     |
| `subject_id`                | The OIDC subject. Never the email or the display name                                                                |
| `route`                     | The static route pattern, not the concrete path — bounded cardinality                                                |
| `incident`                  | The id the user is shown. `jq 'select(.incident=="abc12345")'` finds its line                                        |
| `err.*`                     | `type`, `message`, `stack`, and for a Railway failure `kind`, `status`, `operation`, `code`, `path`, `missing_scope` |

`LOG_LEVEL` is `silent | error | warn | info | debug | trace`, defaulting to `info` in
production and `debug` elsewhere. The Railway client's per-request timing and the
steady-state poll failures sit at `debug` deliberately — at `info` they would be the
dominant volume in the system.

A misconfigured deployment now says so. `env()` throws in the proxy before `/api/health`
can answer, so the app used to return an unlogged 500; it emits one `proxy.env_invalid`
record naming the variables (never their values), once per process rather than on every
healthcheck.

**Getting to Grafana from here** is a deployment change and no code change: add the OTel
packages, add `register()` to the `src/instrumentation.ts` this already created, and
point Alloy at Railway's log drain (`stage.json` → labels on `level`/`service`/`env` →
structured metadata for `request_id`/`incident`/`subject_id`). `trace_id`, `span_id` and
`trace_flags` are left unwritten on purpose: `@opentelemetry/instrumentation-pino` injects
exactly those, and hand-rolling them now would mean two spellings of one concept later.

---

## Typed documents and schema verification

Railway publishes no schema artifact and their API guides omit several things this app
depends on, so the schema is dumped from live introspection and committed:

```bash
RAILWAY_TOKEN=… pnpm schema:pull    # src/lib/railway/schema.graphql — 6 900 lines of SDL
pnpm codegen                        # the documents' result and variable types, from that file
```

`pnpm codegen` validates all twenty-eight documents against that schema and generates
`src/lib/railway/graphql.generated.ts` — 524 lines, being exactly the operation types plus
the nineteen enums and input objects the documents reach. Each export in `operations.ts` is
annotated with its pair:

```ts
export const PROJECT_QUERY: TypedDocument<ProjectQuery, ProjectQueryVariables> = …
```

so `gql`/`gqlPartial` read both off the document and a call site passes no type argument at
all. What that replaced was `gql<{ project: ProjectNode & { services: Edges<ServiceNode> } }>`
— a result shape restated by hand next to the document it claimed to describe, checked by
nothing, alongside a `variables` argument typed `Record<string, unknown>`. A renamed nested
field now fails `pnpm codegen`; a variable of the wrong type fails `pnpm typecheck`.

**The artifact is in git**, which is the decision the rest of this rests on. CI holds no
`RAILWAY_TOKEN`, so a schema fetched at build time would mean neither the typecheck nor the
codegen gate could run there — and a generated file nobody can regenerate is a file nobody
can check. Committed, `pnpm codegen:check` is part of `pnpm check` and of the `quality` job:
regeneration must be a no-op, so a document edited without regenerating fails the merge.
Committing it also makes a Railway-side change readable as lines in a pull request rather
than as a runtime `undefined`.

```bash
pnpm verify:schema                       # discovery + documents vs the committed schema
RAILWAY_TOKEN=… pnpm verify:schema       # + documents vs the live API, and the drift between
```

With a token, `scripts/verify-schema.ts` introspects the live API, validates every document
against **it** rather than against the committed copy, and then diffs the two over the surface
the documents reach — 76 selected fields and 38 input members, as of today. The diff is what
catches a change validation cannot see: a field going from `String!` to `String` validates
perfectly and makes every non-null claim in the generated types a lie. An input member
becoming required is the same class, and is invisible to a document because the app builds
those objects in TypeScript.

**There is no field list to maintain any more.** `REQUIRED_FIELDS`, `REQUIRED_INPUT_TYPES` and
`REQUIRED_ENUM_MEMBERS` are gone — three hand-written manifests that could only ever name
_root_ fields, and said nothing about the selections underneath them. Two declarations
survive, because neither is derivable from a document:

- `DEGRADING_OPERATIONS` — `ProjectMetrics`, `DeploymentEvents`, `EnvironmentVolumes`,
  `Regions` and `Deployments`, the five documents whose
  refusal degrades a readout rather than breaking the app. A validation error inside those is
  reported and does not fail the run. That is a product decision, not a fact about the schema.
  `DeploymentRollback` is deliberately not among them although it is the mutation
  `Deployments` supplies: a control that is honestly unavailable is fine, and a control still
  rendered over a mutation Railway has withdrawn is a control that lies.
- `OPTIONAL_FIELDS` — capabilities Railway does not document and this app does not use, with
  what the app cannot do without each. Six entries as of 2026-08-15 — `deploymentRemove`,
  `variableUpsert`, `volumeUpdate`, `volumeInstanceUpdate`, `customDomainCreate` and
  `tcpProxyCreate` — all of which exist and none of which is sent;
  see Limitations for why. No document mentions them, so no derivation can find them. `deploymentStop`,
  `serviceInstanceUpdate` and `deploymentRollback` were all listed here and are documents now,
  which is the whole
  distinction this list draws: a capability the app wants is reported, a capability it
  depends on fails the run.

It also prints every **deprecated** field the app selects, which found two on the first run
and both are load-bearing: `User.projects` (_"This field will not return anything anymore, go
through the workspace's projects"_) and `Service.serviceInstances` (_"Use
environment.serviceInstances for properly scoped access control"_). They still answer, and
the personal project source is exactly the one the section below is about. That is reported,
not gated — a deprecation is an announcement, and the app keeps working until the field goes.

CI runs the discovery check and the committed-schema validation on every push; the live
comparison is local, because CI has no token to make it with.

### When the dashboard says there are no projects

Verification proves the document is valid, which is a different claim from the data being
there — and the project list is read from `me`, where `User.projects` is deprecated upstream
with _"This field will not return anything anymore, go through the workspace's projects"_.
When the dashboard reports an empty list for an account that plainly has projects, the cause
is one of four things that look identical from the outside: consent granted a narrower scope
than was asked for, the OAuth token sees a different viewer than the browser session, the
projects hang off a connection the app does not query — which that deprecation says is now
the likeliest of the four — or there genuinely are none.

Note the shape of Railway's refusal, because it is not the one the spec suggests: an
unauthorized field returns **HTTP 200** with `{"message":"Not Authorized","extensions":
{"code":"INTERNAL_SERVER_ERROR"}}`. Matching only `UNAUTHENTICATED`/`FORBIDDEN`
classified every permission problem as a generic operation failure — which is how the
UI came to show "Railway rejected the operation. Reference …" beside a Retry that could
not possibly work, while withholding the re-authorize that would have.

`scripts/probe-projects.ts` tells them apart, using the session's **own** OAuth access
token rather than an account token — those two credentials have different visibility,
and it is the OAuth one that is in question:

```bash
RC_SESSION="<rc_session cookie value>" pnpm probe:projects
```

Copy the cookie from DevTools → Application → Cookies. It prints the granted scopes
against the requested ones, the raw payload from each candidate project source, and a
type-level introspection of `User` and `Query`. Read the payloads before changing
`PROJECTS_QUERY` — that is what the script is for.

### When a failed row does not say why

`scripts/probe-deployment.ts` answers the one question introspection could not. The
`deploymentEvents` feed and its `DeploymentEventPayload` were confirmed against the live
schema, but _which_ of `payload.error`, `payload.reason` and `payload.detail` Railway fills
in on a real failure has never been observed — so the app tries all three in a documented
order, and this checks that order against a real deployment:

```bash
RC_SESSION="<rc_session cookie value>" pnpm probe:deployment <deployment-id>
```

Take the id from a failed deployment's URL on Railway. It prints every event verbatim,
which text members were populated, and what the app's own picker chose from them. If the
populated member is not the one that won, reorder `TEXT_MEMBERS` in
`src/lib/railway/failure-reason.ts` and correct the Limitations entry — nothing else in the
app depends on which one it is.

---

## License

MIT — see [LICENSE](LICENSE). Clone it, run it, take what is useful.
