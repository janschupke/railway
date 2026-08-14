import { isTransitioning, type Container } from "@/lib/railway/types";

/**
 * What a managed row offers besides Destroy.
 *
 * Destroy is not a member: it is offered in every state, needs no deployment, and carries a
 * different confirmation — which is the distinction this list is drawing. These three are
 * the reversible ones.
 */
export type ContainerAction = "stop" | "restart" | "redeploy";

/**
 * Which of them apply to a container in this state.
 *
 * Derived rather than stored, because there is nowhere to store it: this app has no
 * database, so the only thing that can say whether a container is running is the
 * deployment status Railway last reported. The rules are about what the mutation would
 * actually do:
 *
 *   - **stop** needs something running or on its way to running.
 *   - **restart** needs a container to restart, so `running` alone. Restarting a build is
 *     not something Railway can do, and offering it mid-deploy would be a control that
 *     answers with an error.
 *   - **redeploy** is everything settled and not running — failed, sleeping, removed, an
 *     unknown status this app does not model, or a service with no deployment at all. That
 *     last one is the orphan a refused first deploy leaves behind, and it is the row this
 *     control matters most on: before it existed the only thing offered there was Destroy.
 *
 * Stop and redeploy are therefore exclusive by construction, which is what keeps the row to
 * three controls at any one time.
 */
export function availableActions(
  container: Pick<Container, "state" | "deploymentId">,
): ContainerAction[] {
  /*
   * Nothing, deliberately. `removing` is the one state where the container is already
   * being taken away, so stopping it is a no-op and redeploying it is a race against
   * Railway — which is the same reason the row disables Destroy here.
   */
  if (container.state === "removing") return [];

  if (!container.deploymentId) return ["redeploy"];
  if (container.state === "running") return ["stop", "restart"];
  // Everything still transitioning: queued, building, deploying.
  if (isTransitioning(container.state)) return ["stop"];
  return ["redeploy"];
}
