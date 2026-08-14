/**
 * Every GraphQL document the app sends, in one file.
 *
 * Railway does not publish a schema artifact, so `pnpm schema:pull` dumps one from live
 * introspection into ./schema.graphql, `pnpm codegen` generates the result and variable
 * types below from it, and every document here is validated against it — nested fields,
 * argument names, enum members and all. A renamed field fails `pnpm codegen`, and a
 * mismatched result type fails `pnpm typecheck` at the call site.
 *
 * `pnpm verify:schema` is what says whether that committed schema still matches the live
 * API. It validates these same documents against Railway's current schema and diffs the
 * surface they reach — see README, "Schema verification".
 *
 * The type annotations are the load-bearing part of each export. `TypedDocument<Result,
 * Variables>` is what `gql`/`gqlPartial` read the shapes from, so a document and its types
 * cannot drift apart and the variables are checked against the document that consumes them.
 */

import type {
  BuildLogsQuery,
  BuildLogsQueryVariables,
  DeploymentEventsQuery,
  DeploymentEventsQueryVariables,
  DeploymentLogsQuery,
  DeploymentLogsQueryVariables,
  DeploymentQuery,
  DeploymentQueryVariables,
  DeploymentRestartMutation,
  DeploymentRestartMutationVariables,
  DeploymentStopMutation,
  DeploymentStopMutationVariables,
  EnvironmentCreateMutation,
  EnvironmentCreateMutationVariables,
  EnvironmentVolumesQuery,
  EnvironmentVolumesQueryVariables,
  ProjectCreateMutation,
  ProjectCreateMutationVariables,
  ProjectMetricsQuery,
  ProjectMetricsQueryVariables,
  ProjectQuery,
  ProjectQueryVariables,
  ProjectsPersonalQuery,
  ProjectsPersonalQueryVariables,
  ProjectsWorkspaceQuery,
  ProjectsWorkspaceQueryVariables,
  RegionsQuery,
  RegionsQueryVariables,
  ServiceCreateMutation,
  ServiceCreateMutationVariables,
  ServiceDeleteMutation,
  ServiceDeleteMutationVariables,
  ServiceDomainCreateMutation,
  ServiceDomainCreateMutationVariables,
  ServiceInstanceDeployV2Mutation,
  ServiceInstanceDeployV2MutationVariables,
  ServiceInstanceLimitsUpdateMutation,
  ServiceInstanceLimitsUpdateMutationVariables,
  ServiceInstanceUpdateMutation,
  ServiceInstanceUpdateMutationVariables,
  ServiceUpdateMutation,
  ServiceUpdateMutationVariables,
  ServiceVariablesQuery,
  ServiceVariablesQueryVariables,
  StreamBuildLogsSubscription,
  StreamBuildLogsSubscriptionVariables,
  StreamDeploymentLogsSubscription,
  StreamDeploymentLogsSubscriptionVariables,
  VariableCollectionUpsertMutation,
  VariableCollectionUpsertMutationVariables,
  VariableDeleteMutation,
  VariableDeleteMutationVariables,
  VolumeCreateMutation,
  VolumeCreateMutationVariables,
  VolumeDeleteMutation,
  VolumeDeleteMutationVariables,
} from "./graphql.generated";
import type { TypedDocument } from "./typed-document";

/** A fragment, not an operation: interpolated into the three documents that select it. */
const PROJECT_FIELDS = /* GraphQL */ `
  fragment ProjectFields on Project {
    id
    name
    environments {
      edges {
        node {
          id
          name
        }
      }
    }
  }
`;

/*
 * The project list is read as three independent documents rather than one.
 *
 * They used to be a single query, and that is what broke the dashboard outright: an
 * OAuth token holding `project:admin` but no workspace scope makes Railway refuse the
 * `workspaces` field, and a refusal anywhere in the document was treated as a refusal
 * of the whole thing — so a personal project list that had arrived perfectly intact was
 * thrown away, on every load, forever.
 *
 * Separate documents mean one source failing costs exactly that source. `listProjects`
 * merges whatever answered and only fails when nothing did.
 *
 * `pnpm probe:projects` prints what each source actually returns for a real session;
 * run that before editing these, rather than reasoning about which one "should" work.
 */

/**
 * The personal project source, which also carries identity.
 *
 * `name` and `email` used to come from a third document of their own, issued in
 * parallel purely to read `me { id name email }` — fields this query was already one
 * selection away from. Railway's rate limit is the binding constraint on this app
 * (1000/hour on Hobby), so a whole request per dashboard load for three scalars is the
 * expensive kind of tidy. A token refused these two fields degrades to a nameless
 * header rather than an empty dashboard: they are optional on ViewerNode, and gqlPartial
 * keeps whatever `me` did return.
 */
export const PROJECTS_PERSONAL_QUERY: TypedDocument<
  ProjectsPersonalQuery,
  ProjectsPersonalQueryVariables
> = /* GraphQL */ `
  ${PROJECT_FIELDS}
  query ProjectsPersonal {
    me {
      id
      name
      email
      projects {
        edges {
          node {
            ...ProjectFields
          }
        }
      }
    }
  }
`;

/**
 * Projects owned by a workspace the user belongs to.
 *
 * Selects `workspace.projects` rather than `workspace.team.projects`: both survive
 * validation, but only the former appears in the live introspected field list for
 * `Workspace`, so the latter is the one liable to disappear without notice. Requires a
 * `workspace:*` scope at consent — see SCOPES in lib/auth/oidc.ts.
 */
export const PROJECTS_WORKSPACE_QUERY: TypedDocument<
  ProjectsWorkspaceQuery,
  ProjectsWorkspaceQueryVariables
> = /* GraphQL */ `
  ${PROJECT_FIELDS}
  query ProjectsWorkspace {
    me {
      id
      workspaces {
        id
        name
        projects {
          edges {
            node {
              ...ProjectFields
            }
          }
        }
      }
    }
  }
`;

/**
 * The dashboard's own read: one project, its environments, and every service in it.
 *
 * `domains { serviceDomains { domain } }` is the one selection here that had to argue for
 * itself, because this is the document PROJECT_METRICS_QUERY below exists in order to stay
 * out of. It is polled every WATCH_POLL_MS for the life of every open watcher and it is
 * sent through `gql` rather than `gqlPartial`, so a field withdrawn from it is a rejection
 * on *every* tick rather than a missing readout.
 *
 * It is accepted here and refused there because the alternatives are worse rather than
 * because the risk is smaller:
 *
 *   - `Query.domains(projectId, environmentId, serviceId)` answers the same thing per
 *     service, which is a request per row on a list — exactly the third polling source
 *     ADR-10's budget cannot absorb.
 *   - A URL read anywhere other than the row's own read does not survive
 *     `router.refresh()`, and the refresh after a spin-up is precisely when the URL first
 *     exists.
 *
 * What bounds the risk: `ServiceInstance.domains` is `AllDomains!` and `serviceDomains` is
 * `[ServiceDomain!]!` — both non-null, neither deprecated, and `pnpm verify:schema` reports
 * any of that changing.
 *
 * `customDomains` is deliberately not selected. This app cannot place a DNS record it does
 * not own, so it can neither create one nor say whether one is working; a domain it did not
 * make and cannot verify is not a link it should present as this container's address.
 */
export const PROJECT_QUERY: TypedDocument<ProjectQuery, ProjectQueryVariables> =
  /* GraphQL */ `
    query Project($id: String!) {
      project(id: $id) {
        id
        name
        environments {
          edges {
            node {
              id
              name
            }
          }
        }
        services {
          edges {
            node {
              id
              name
              createdAt
              serviceInstances {
                edges {
                  node {
                    id
                    environmentId
                    source {
                      image
                      repo
                    }
                    domains {
                      serviceDomains {
                        domain
                      }
                    }
                    latestDeployment {
                      id
                      status
                      createdAt
                      updatedAt
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

/**
 * What the containers in one environment are using, and what the workspace has spent.
 *
 * Two root fields in one document because they are both root fields, both optional, and
 * both wanted by the same render — and because `gqlPartial` means a refusal of either costs
 * only that half.
 *
 * NOT folded into PROJECT_QUERY, which is the important part. That document is polled every
 * WATCH_POLL_MS for the life of every open watcher, so a refused or withdrawn `metrics`
 * field there would be a rejection on *every* tick — which the watch loop classifies as
 * transient, backs off from, and rides out. The dashboard would stop noticing that
 * containers had changed because a readout was refused. It would also force
 * `getProjectContainers` onto `gqlPartial`, softening the app's most important read for a
 * field nobody asked to be forgiving. Same trade DEPLOYMENT_EVENTS_QUERY makes, for the
 * same reason.
 *
 * `groupBy: [SERVICE_ID]` rather than a `serviceId` argument: one request covers every
 * service in the environment, whatever the list length. A per-row query would be exactly the
 * third polling source ADR-10's budget cannot absorb.
 *
 * `tags { serviceId }` and nothing else. `deploymentId`, `environmentId`, `region`,
 * `volumeId` and four more all exist and are all left out — each is one more field whose
 * withdrawal takes the whole document with it, and none of them changes what the row says.
 *
 * `endDate` is deliberately not sent. Absent means "up to now"; sending a client-computed
 * end is one clock-skew bug away from an empty series, and there is nothing to gain.
 *
 * `project.workspace` is NULLABLE on the live schema — a personal project belongs to no
 * workspace — so null here is an ordinary state and not a failure. `customer.currentUsage`
 * is the only monetary figure anywhere in Railway's schema, and it covers the whole
 * workspace; `estimatedUsage` returns GB and vCPU rather than money, which is why it is not
 * selected here. Whatever renders this has to say which of those it is showing.
 */
export const PROJECT_METRICS_QUERY: TypedDocument<
  ProjectMetricsQuery,
  ProjectMetricsQueryVariables
> = /* GraphQL */ `
  query ProjectMetrics(
    $projectId: String!
    $environmentId: String!
    $measurements: [MetricMeasurement!]!
    $startDate: DateTime!
    $sampleRateSeconds: Int
    $averagingWindowSeconds: Int
  ) {
    metrics(
      projectId: $projectId
      environmentId: $environmentId
      measurements: $measurements
      startDate: $startDate
      groupBy: [SERVICE_ID]
      sampleRateSeconds: $sampleRateSeconds
      averagingWindowSeconds: $averagingWindowSeconds
    ) {
      measurement
      tags {
        serviceId
      }
      values {
        ts
        value
      }
    }
    project(id: $projectId) {
      id
      workspace {
        id
        name
        customer {
          currentUsage
          billingPeriod {
            start
            end
          }
        }
      }
    }
  }
`;

/**
 * Where a container can be created, read live rather than committed.
 *
 * A hardcoded list would be a list that goes stale silently, and the failure mode of a stale
 * one is the worst shape available here: a create refused for a region this app's own form
 * offered. Railway adds datacentres and retires them, and neither event produces a build
 * failure anywhere.
 *
 * Scoped by `projectId`. The argument is nullable and is sent anyway — availability is not
 * established to be global, and a list that is right for the project the form is pointed at
 * is the only list worth offering.
 *
 * `id` is nullable on `Region` while `name`, `location` and `country` are not, so a region
 * Railway lists can carry no identifier to submit; the mapper drops those rather than
 * offering a choice that posts an empty string. `deprecationInfo` is selected for the same
 * class of reason — a deprecated region is a future failure with a date on it, and offering
 * one is offering a container that stops working later.
 */
export const REGIONS_QUERY: TypedDocument<RegionsQuery, RegionsQueryVariables> =
  /* GraphQL */ `
    query Regions($projectId: String) {
      regions(projectId: $projectId) {
        id
        name
        location
        country
        deploymentConstraints {
          deprecationInfo {
            isDeprecated
          }
        }
      }
    }
  `;

/**
 * A new project on the signed-in user's personal account.
 *
 * Selects `...ProjectFields` rather than a bare `id`, and that is what the create flow is
 * built on: `projectCreate` returns `Project!` — the same type the list query reads — so
 * the default environment Railway makes alongside the project arrives in this response.
 * Without it the client would have a project id and no environment id, and would have to
 * re-read the whole project list before it could select what it had just created.
 *
 * `ProjectCreateInput` also carries `workspaceId`, `defaultEnvironmentName`, `description`,
 * `isPublic`, `prDeploys`, `repo`, `runtime` and `isMonorepo`. The app sends `name` and
 * nothing else: an omitted `workspaceId` is what makes the project personal, and every
 * other member is a decision the user has not been asked to make. Sending one is all it
 * takes for its removal to fail verification now: the member is in
 * `ProjectCreateMutationVariables`, so `pnpm typecheck` rejects the object the day
 * `pnpm schema:pull` stops finding it, and there is no list to remember to update.
 */
export const PROJECT_CREATE_MUTATION: TypedDocument<
  ProjectCreateMutation,
  ProjectCreateMutationVariables
> = /* GraphQL */ `
  ${PROJECT_FIELDS}
  mutation ProjectCreate($input: ProjectCreateInput!) {
    projectCreate(input: $input) {
      ...ProjectFields
    }
  }
`;

/**
 * A new environment inside an existing project.
 *
 * `skipInitialDeploys: true` is load-bearing rather than tidy. Railway seeds a new
 * environment from an existing one and deploys what it copies, so a person clicking "New
 * environment" would be billed for a duplicate of every service in the project without
 * having asked for one. This app creates infrastructure only when someone names it, and
 * `sourceEnvironmentId` is deliberately not sent for the same reason.
 *
 * `ephemeral`, `stageInitialChanges` and `applyChangesInBackground` are the remaining
 * members and are all left out — see the note on ProjectCreateInput above.
 */
export const ENVIRONMENT_CREATE_MUTATION: TypedDocument<
  EnvironmentCreateMutation,
  EnvironmentCreateMutationVariables
> = /* GraphQL */ `
  mutation EnvironmentCreate($input: EnvironmentCreateInput!) {
    environmentCreate(input: $input) {
      id
      name
    }
  }
`;

export const SERVICE_CREATE_MUTATION: TypedDocument<
  ServiceCreateMutation,
  ServiceCreateMutationVariables
> = /* GraphQL */ `
  mutation ServiceCreate($input: ServiceCreateInput!) {
    serviceCreate(input: $input) {
      id
      name
    }
  }
`;

/**
 * Rename a service.
 *
 * The one thing about editing a container that is not on the *instance*. Railway splits a
 * service in two — `Service` carries the name, `ServiceInstance` carries everything about
 * how it runs — and only the second has an update input worth the name. So a feature
 * described as "edit the service" is two mutations, and this is the half the ticket for it
 * did not know about: `ServiceInstanceUpdateInput` has no `name` member and never had one.
 *
 * The name is this app's ownership marker (ADR-5), so what is sent here has already been
 * through `toManagedName` — see the edit action. There is no rename path that skips it.
 *
 * `ServiceUpdateInput` also carries `icon`, which is left out: it is a decision nobody has
 * been asked to make, and the argument is the one PROJECT_CREATE_MUTATION makes at length.
 */
export const SERVICE_UPDATE_MUTATION: TypedDocument<
  ServiceUpdateMutation,
  ServiceUpdateMutationVariables
> = /* GraphQL */ `
  mutation ServiceUpdate($id: String!, $input: ServiceUpdateInput!) {
    serviceUpdate(id: $id, input: $input) {
      id
      name
    }
  }
`;

/**
 * Change what image a service runs, without destroying it.
 *
 * The whole point of the edit feature: moving `postgres:16-alpine` to `postgres:17` used to
 * mean `serviceDelete` and a fresh `serviceCreate`, which for a database means losing it.
 *
 * `source` is the only member sent. `ServiceInstanceUpdateInput` offers twenty-odd others —
 * region, replicas, healthcheck, start command, restart policy — and each is a feature with
 * its own ticket rather than something to pass through untouched. Sending only `source`
 * means Railway leaves every one of them alone.
 *
 * `environmentId` is nullable on the schema and is always sent regardless. Railway's own
 * comment on the argument says an omitted environment updates the service in *every*
 * environment that is not a fork — which is a blast radius nobody asked for, from a form
 * that names one environment.
 *
 * There is no `skipDeploys` member here, unlike VariableCollectionUpsertInput. If Railway
 * redeploys on a source change, that deployment is one this app never learns the id of — so
 * the edit issues its own deploy afterwards and keys the row on that. See updateContainer.
 */
export const SERVICE_INSTANCE_UPDATE_MUTATION: TypedDocument<
  ServiceInstanceUpdateMutation,
  ServiceInstanceUpdateMutationVariables
> = /* GraphQL */ `
  mutation ServiceInstanceUpdate(
    $serviceId: String!
    $environmentId: String!
    $input: ServiceInstanceUpdateInput!
  ) {
    serviceInstanceUpdate(
      serviceId: $serviceId
      environmentId: $environmentId
      input: $input
    )
  }
`;

/**
 * How much CPU and memory a service may have, which is not on ServiceInstanceUpdateInput.
 *
 * Railway splits sizing into its own mutation and its own input, and the split is
 * load-bearing rather than cosmetic: this one is gated by the plan behind the token where
 * the other is not. A refusal here means "your plan does not allow a service that size" and
 * a refusal there means the settings themselves were rejected, so `createContainer` sends
 * them as two steps with two outcomes rather than one — see the outcome union there.
 *
 * `Float`, both members, and the form deliberately imposes no step grid on them: a quarter
 * of a vCPU is a value Railway accepts and a `step="0.5"` input would refuse before the
 * server ever saw it.
 */
export const SERVICE_INSTANCE_LIMITS_UPDATE_MUTATION: TypedDocument<
  ServiceInstanceLimitsUpdateMutation,
  ServiceInstanceLimitsUpdateMutationVariables
> = /* GraphQL */ `
  mutation ServiceInstanceLimitsUpdate($input: ServiceInstanceLimitsUpdateInput!) {
    serviceInstanceLimitsUpdate(input: $input)
  }
`;

/**
 * `serviceInstanceDeployV2` returns the new deployment id, which is what the log
 * subscription keys on. The older `serviceInstanceDeploy` returns a Boolean and would
 * force a follow-up query to find the deployment.
 */
export const SERVICE_DEPLOY_MUTATION: TypedDocument<
  ServiceInstanceDeployV2Mutation,
  ServiceInstanceDeployV2MutationVariables
> = /* GraphQL */ `
  mutation ServiceInstanceDeployV2($serviceId: String!, $environmentId: String!) {
    serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
  }
`;

export const SERVICE_DELETE_MUTATION: TypedDocument<
  ServiceDeleteMutation,
  ServiceDeleteMutationVariables
> = /* GraphQL */ `
  mutation ServiceDelete($id: String!) {
    serviceDelete(id: $id)
  }
`;

/**
 * Give a service an address on the public internet.
 *
 * Railway mints the hostname itself — `spun-cache-production.up.railway.app` — so there is
 * nothing to name and nothing to check for availability. `serviceDomainAvailable` exists
 * and is not used: it answers about a hostname the caller proposes, and this app proposes
 * none.
 *
 * `targetPort` is the port *inside* the container that the edge routes to, and it is
 * optional on the input. Sending it is not the same as omitting it: omitted, Railway infers
 * a port from the running deployment, which needs a deployment to exist and is documented
 * nowhere. The catalog knows the port for every image it offers (`Preset.httpPort`), so the
 * spin-up path always sends one and only the row control — reached for an image the catalog
 * has never heard of — falls back to the inference.
 *
 * `domain` is what the row renders. `id` and `targetPort` are selected because a mutation
 * that answers only with a string it also could have been asked for is a mutation whose
 * result cannot be told apart from an echo — and `id` is what `serviceDomainDelete` would
 * need if this app ever offered taking a domain away.
 *
 * Two neighbouring mutations are deliberately absent:
 *
 *   - `customDomainCreate(input)` attaches a hostname the user owns, which needs a CNAME
 *     this app cannot place and a certificate issue it cannot observe. It would be a
 *     control that succeeds and then appears broken for reasons living in someone's DNS.
 *   - `tcpProxyCreate(input)` is how redis and postgres would become reachable, and it is
 *     `@deprecated` on the live schema — "use staged changes and apply them", plus a
 *     redeploy the caller has to perform itself before the proxy is active. Shipping the
 *     database presets' reachability on a retiring mutation is a worse trade than leaving
 *     them private, which is what Railway's own private networking already makes them.
 */
export const SERVICE_DOMAIN_CREATE_MUTATION: TypedDocument<
  ServiceDomainCreateMutation,
  ServiceDomainCreateMutationVariables
> = /* GraphQL */ `
  mutation ServiceDomainCreate($input: ServiceDomainCreateInput!) {
    serviceDomainCreate(input: $input) {
      id
      domain
      targetPort
    }
  }
`;

/**
 * Attach a persistent volume to a service that has just been created.
 *
 * The five presets that carry a generated credential — six with rabbitmq — wrote to a
 * container filesystem that is discarded every time the container moves, so a database
 * spun up here accepted data and lost it. This is the mutation that stops that; the mount
 * path per image is catalog metadata (`Preset.volume` in lib/presets.ts).
 *
 * `environmentId` is sent explicitly and always. The schema's own description is the reason:
 * `null` deploys the volume to no environment and **`undefined` deploys it to every
 * environment in the project**, so omitting the member for a service in one environment
 * would silently provision billable storage in all of the others.
 *
 * `id name` and nothing else, though `Volume` also offers `createdAt`, `project` and a
 * deprecated `volumeInstances`. `name` is selected purely so the create path can record what
 * Railway called it: it names the volume after the service — `spun-pg` gets `spun-pg-volume`
 * — which is what makes the ownership prefix reach the volume without this app renaming
 * anything. See VOLUME_DELETE_MUTATION for what that buys.
 *
 * `VolumeCreateInput` also carries `region`, which is not sent: Railway places the volume in
 * the service's own region by default, and an app that let those diverge would be offering a
 * latency footgun with no UI to explain it.
 *
 * There is no size member on the input at all — Railway provisions at the deployer's plan
 * default (500 MB when this was probed) — so this app cannot offer a size and does not
 * pretend to. README Limitations says so.
 */
export const VOLUME_CREATE_MUTATION: TypedDocument<
  VolumeCreateMutation,
  VolumeCreateMutationVariables
> = /* GraphQL */ `
  mutation VolumeCreate($input: VolumeCreateInput!) {
    volumeCreate(input: $input) {
      id
      name
    }
  }
`;

/**
 * Delete a volume, and with it everything written to it.
 *
 * Reached from exactly one place — the destroy action, below the ownership check, and only
 * when the confirmation dialog's checkbox said so. `mutation-callsites.test.ts` asserts that
 * structurally, the same way it does for `serviceDelete`.
 *
 * The ownership argument is ADR-13 and it is worth restating here, because this is the call
 * that acts on it: a volume's owner is **the service it is mounted on**, not its name. This
 * app creates a volume only as a step of creating a service, the service carries the
 * `MANAGED_PREFIX` marker, and `withManagedContainer` has already re-derived that from
 * Railway's own response before this document is ever sent. Matching on the volume's own
 * name would be weaker, not stronger: Railway's auto-name is derived from the service's, so
 * it would be the same claim read through one more indirection — and a volume whose service
 * was renamed in Railway's dashboard would become undeletable from here for no gain.
 *
 * Railway answers a Boolean. Deletion is asynchronous behind it, so the row learns what
 * happened from the next read rather than from this response.
 */
export const VOLUME_DELETE_MUTATION: TypedDocument<
  VolumeDeleteMutation,
  VolumeDeleteMutationVariables
> = /* GraphQL */ `
  mutation VolumeDelete($volumeId: String!) {
    volumeDelete(volumeId: $volumeId)
  }
`;

/**
 * The volumes mounted in one environment, so a row can say where its data lives.
 *
 * `environment.volumeInstances`, never `volume.volumeInstances` — the latter is
 * `@deprecated` upstream in favour of this one for "properly scoped access control", and
 * `verify:schema` would print the deprecation on every run.
 *
 * A separate document rather than a selection on PROJECT_QUERY, for the reason that document
 * states at length: it is polled every WATCH_POLL_MS for the life of every open watcher, so a
 * withdrawn or refused field inside it is a rejection on every tick, which the watch loop
 * reads as transient and backs off from. Here the same withdrawal costs one readout. It is
 * read through `gqlPartial` and carries a DEGRADING_OPERATIONS entry to match.
 *
 * `serviceId` is the join, and it is nullable on the schema — a volume whose service was
 * deleted keeps its instance and answers a serviceId that no longer resolves. The mapper
 * drops those rather than trying to render them, because this app has no orphan-volume UI
 * and inventing one here would be a feature hiding inside a mapper.
 *
 * `currentSizeMB` is a Float that moves under the reader. It is selected deliberately — it
 * is the number the destroy dialog needs in order to say how much data is about to go — and
 * it is why `ContainerVolume` is keyed beside the container list rather than merged onto
 * `Container`, whose hash decides whether every open tab reloads. See the docblock on
 * `ContainerMetrics` in ./types.ts, which records what happened the first time.
 */
export const ENVIRONMENT_VOLUMES_QUERY: TypedDocument<
  EnvironmentVolumesQuery,
  EnvironmentVolumesQueryVariables
> = /* GraphQL */ `
  query EnvironmentVolumes($id: String!) {
    environment(id: $id) {
      id
      volumeInstances {
        edges {
          node {
            id
            volumeId
            serviceId
            mountPath
            sizeMB
            currentSizeMB
          }
        }
      }
    }
  }
`;

/**
 * Stop the deployment a service is currently running.
 *
 * Reversible, which is the whole reason it is here: the service, its variables and its
 * deployment history survive, and SERVICE_DEPLOY_MUTATION above brings it back. That is
 * what separates it from `serviceDelete`, after which Railway retains no record the
 * container existed.
 *
 * Railway answers a Boolean and nothing else, so the app learns what stopping did from the
 * next read of PROJECT_QUERY rather than from this response.
 */
export const DEPLOYMENT_STOP_MUTATION: TypedDocument<
  DeploymentStopMutation,
  DeploymentStopMutationVariables
> = /* GraphQL */ `
  mutation DeploymentStop($id: String!) {
    deploymentStop(id: $id)
  }
`;

/**
 * Restart the container of a deployment that is already running, in place.
 *
 * The deployment id does not change, which is the property the row depends on: an open log
 * pane is subscribed to that id, so a restart continues in the pane the user is already
 * watching. A redeploy would make a new deployment and leave them watching the old one.
 *
 * Three neighbouring mutations are deliberately absent, and none of them is an oversight:
 *
 *   - `deploymentRedeploy(id)` returns a fresh `Deployment!` from an existing one, and is
 *     what "redeploy" would obviously be built on. The app redeploys through
 *     `serviceInstanceDeployV2` instead, because that is the only call that also works for
 *     a service with NO deployment — the orphan `createContainer` leaves behind when
 *     Railway refuses the first deploy, which is exactly the row that most needs the
 *     control. One path, one document, one code branch.
 *   - `deploymentRollback(id)` deploys a previous deployment. Choosing which one is a UI
 *     this app does not have, and rolling back to an image tag the user cannot see would
 *     be the least legible thing on the dashboard.
 *   - `deploymentRemove(id)` erases a stopped deployment's record. Nothing in the UI offers
 *     it, and it is the one lifecycle call that destroys something `serviceDelete` does not
 *     already take.
 */
export const DEPLOYMENT_RESTART_MUTATION: TypedDocument<
  DeploymentRestartMutation,
  DeploymentRestartMutationVariables
> = /* GraphQL */ `
  mutation DeploymentRestart($id: String!) {
    deploymentRestart(id: $id)
  }
`;

export const DEPLOYMENT_QUERY: TypedDocument<
  DeploymentQuery,
  DeploymentQueryVariables
> = /* GraphQL */ `
  query Deployment($id: String!) {
    deployment(id: $id) {
      id
      status
      createdAt
      updatedAt
    }
  }
`;

/**
 * Why a deployment failed. A second document on purpose, not four more fields above.
 *
 * The `Deployment` type carries no reason at all — `diagnosis` and `meta` are opaque
 * SCALARs with no documented shape, which is not something to select and render — so the
 * only place the reason exists is this event feed.
 *
 * It stays out of DEPLOYMENT_QUERY because that document is polled every
 * STREAM.STATUS_POLL_MS for the life of every open stream. A field withdrawn or refused
 * there is a rejection on *every* poll, which pollStatus classifies as transient, logs
 * once at warn and then at debug, and rides out for the full STREAM.MAX_DURATION_MS. Here
 * the same withdrawal costs one best-effort read per failed deployment and the row falls
 * back to the sentence it already had.
 *
 * The selection is deliberately minimal for the same reason: `id`, `createdAt`,
 * `completedAt`, `attempt` and `maxAttempts` all exist and are all left out, because each
 * is one more field whose withdrawal would take the whole document with it and none of
 * them changes what the row says. `skipped` earns its place by changing which event is
 * chosen; `step` earns its place by being a bounded enum this app can translate, and the
 * only useful thing left when all three text members come back null.
 */
export const DEPLOYMENT_EVENTS_QUERY: TypedDocument<
  DeploymentEventsQuery,
  DeploymentEventsQueryVariables
> = /* GraphQL */ `
  query DeploymentEvents($id: String!, $last: Int) {
    deploymentEvents(id: $id, last: $last) {
      edges {
        node {
          step
          payload {
            error
            reason
            detail
            skipped
          }
        }
      }
    }
  }
`;

export const DEPLOYMENT_LOGS_QUERY: TypedDocument<
  DeploymentLogsQuery,
  DeploymentLogsQueryVariables
> = /* GraphQL */ `
  query DeploymentLogs($deploymentId: String!, $limit: Int) {
    deploymentLogs(deploymentId: $deploymentId, limit: $limit) {
      timestamp
      message
      severity
    }
  }
`;

export const BUILD_LOGS_QUERY: TypedDocument<BuildLogsQuery, BuildLogsQueryVariables> =
  /* GraphQL */ `
    query BuildLogs($deploymentId: String!, $limit: Int) {
      buildLogs(deploymentId: $deploymentId, limit: $limit) {
        timestamp
        message
        severity
      }
    }
  `;

/** Streamed over `wss://backboard.railway.com/graphql/v2` (graphql-transport-ws). */
export const DEPLOYMENT_LOGS_SUBSCRIPTION: TypedDocument<
  StreamDeploymentLogsSubscription,
  StreamDeploymentLogsSubscriptionVariables
> = /* GraphQL */ `
  subscription StreamDeploymentLogs($deploymentId: String!) {
    deploymentLogs(deploymentId: $deploymentId) {
      timestamp
      message
      severity
    }
  }
`;

export const BUILD_LOGS_SUBSCRIPTION: TypedDocument<
  StreamBuildLogsSubscription,
  StreamBuildLogsSubscriptionVariables
> = /* GraphQL */ `
  subscription StreamBuildLogs($deploymentId: String!) {
    buildLogs(deploymentId: $deploymentId) {
      timestamp
      message
      severity
    }
  }
`;

/**
 * Environment for a service, set in one call.
 *
 * `replace: false` — the service was created moments ago and has nothing to replace, and
 * a mutation that can silently wipe variables is the wrong default to have lying around.
 */
export const VARIABLE_COLLECTION_UPSERT_MUTATION: TypedDocument<
  VariableCollectionUpsertMutation,
  VariableCollectionUpsertMutationVariables
> = /* GraphQL */ `
  mutation VariableCollectionUpsert($input: VariableCollectionUpsertInput!) {
    variableCollectionUpsert(input: $input)
  }
`;

/**
 * What a service's own environment currently holds — two reads, one round trip.
 *
 * Railway's `variables` field answers *everything a service resolves*, which includes the
 * shared variables the environment sets for all of them. The edit form must not offer those:
 * they are not the service's to change, and a row someone deletes there would be a delete
 * this app cannot honour — `variableDelete` carrying a `serviceId` only ever removes a
 * service-scoped variable.
 *
 * So the same field is asked twice in one document, once with the service and once without,
 * and the caller subtracts. Aliases rather than two requests because Railway's rate limit is
 * the binding constraint on this app, and this read happens every time someone opens the
 * editor.
 *
 * The subtraction is by name **and value**, not by name — a service is allowed to override a
 * shared name with its own value, and dropping it by name would hide a variable the service
 * genuinely owns. See readServiceVariableNames.
 *
 * `unrendered: true` asks for the raw text, so a `${{...}}` reference comes back as itself
 * rather than resolved. This app only ever reports the *names* to a browser, so resolving
 * them would be work done purely to throw the answer away.
 *
 * Both fields are the `EnvironmentVariables` scalar, which codegen.ts already maps to
 * `Record<string, string>` for the upsert input — so the read is typed by the same line that
 * types the write, and neither had to describe the map twice.
 */
export const SERVICE_VARIABLES_QUERY: TypedDocument<
  ServiceVariablesQuery,
  ServiceVariablesQueryVariables
> = /* GraphQL */ `
  query ServiceVariables(
    $projectId: String!
    $environmentId: String!
    $serviceId: String!
  ) {
    service: variables(
      projectId: $projectId
      environmentId: $environmentId
      serviceId: $serviceId
      unrendered: true
    )
    shared: variables(
      projectId: $projectId
      environmentId: $environmentId
      unrendered: true
    )
  }
`;

/**
 * Remove one variable from one service.
 *
 * This is what an edit uses instead of `variableCollectionUpsert` with `replace: true`, and
 * the difference is what can go wrong when the app is mistaken. `replace: true` deletes
 * everything the app did not send — so a variable the read above failed to report, for any
 * reason, is gone. Per-key deletion can only remove a name the person looking at the editor
 * actually removed from it.
 *
 * `serviceId` is not optional in practice even though the schema allows omitting it: without
 * one this deletes the environment's *shared* variable of that name, for every service in
 * the project.
 */
export const VARIABLE_DELETE_MUTATION: TypedDocument<
  VariableDeleteMutation,
  VariableDeleteMutationVariables
> = /* GraphQL */ `
  mutation VariableDelete($input: VariableDeleteInput!) {
    variableDelete(input: $input)
  }
`;

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
  {
    root: "Mutation",
    field: "deploymentRollback",
    note: "a container can be restarted and redeployed, but never rolled back",
  },
  /*
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
