"use client";

import { Play, RotateCcw, Square } from "lucide-react";
import {
  redeployContainer,
  restartContainer,
  stopContainer,
} from "@/app/dashboard/actions";
import { availableActions, type ContainerAction } from "@/lib/container-actions";
import type { ContainerState } from "@/lib/railway/types";
import { DestroyContainerDialog } from "./destroy-container-dialog";
import { EditContainerDialog } from "./edit-container-dialog";
import { LifecycleActionDialog } from "./lifecycle-action-dialog";

/**
 * What each verb sends and what it looks like.
 *
 * A record rather than a switch in the JSX, so adding a fourth reversible action is one
 * entry here plus one branch in `availableActions` — and so the Server Action, the icon and
 * the catalog namespace for a verb are visibly one thing.
 */
const ACTIONS: Record<
  ContainerAction,
  { run: typeof stopContainer; icon: React.ReactNode }
> = {
  stop: { run: stopContainer, icon: <Square aria-hidden /> },
  restart: { run: restartContainer, icon: <RotateCcw aria-hidden /> },
  redeploy: { run: redeployContainer, icon: <Play aria-hidden /> },
};

/**
 * Everything a managed row can do to its container.
 *
 * Gated on state rather than rendered-and-disabled: a disabled control is a promise that
 * something would happen if only the row were in another state, and "Restart" on a
 * container that is still building is not a promise this app can keep. At most three
 * controls are ever on screen at once — see `availableActions`, which is where that bound
 * is asserted.
 *
 * `state` is the row's live value, preferring the stream over the last server render, so
 * the controls change with the badge rather than a refresh behind it.
 */
export function ContainerActions({
  serviceId,
  displayName,
  image,
  deploymentId,
  state,
  projectId,
  environmentId,
}: {
  serviceId: string;
  displayName: string;
  /** Seeds the edit form. Null for a service Railway describes with a repo — see ADR-6. */
  image: string | null;
  deploymentId: string | null;
  state: ContainerState;
  projectId: string;
  environmentId: string;
}) {
  const actions = availableActions({ state, deploymentId });

  return (
    // Wraps as one unit rather than letting the row break between two of these controls.
    <div className="flex flex-wrap items-center justify-end gap-2">
      {/*
        Not in `availableActions`, and not for want of a fourth entry. That list answers
        "would this mutation do anything in this state", which is a question about a running
        deployment — editing is a change to the container's *description*, and every state
        has one. The single exception is the state where the description is on its way out.
      */}
      <EditContainerDialog
        serviceId={serviceId}
        displayName={displayName}
        image={image}
        projectId={projectId}
        environmentId={environmentId}
        disabled={state === "removing"}
      />

      {actions.map((action) => (
        <LifecycleActionDialog
          key={action}
          action={action}
          run={ACTIONS[action].run}
          icon={ACTIONS[action].icon}
          serviceId={serviceId}
          displayName={displayName}
          projectId={projectId}
          environmentId={environmentId}
        />
      ))}

      <DestroyContainerDialog
        serviceId={serviceId}
        displayName={displayName}
        projectId={projectId}
        environmentId={environmentId}
        disabled={state === "removing"}
      />
    </div>
  );
}
