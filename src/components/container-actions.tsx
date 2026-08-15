"use client";

import { Play, RotateCcw, Square } from "lucide-react";
import {
  redeployContainer,
  restartContainer,
  stopContainer,
} from "@/app/dashboard/actions";
import { availableActions, type ContainerAction } from "@/lib/container-actions";
import type {
  Container,
  ContainerMetrics,
  ContainerState,
  ContainerVolume,
} from "@/lib/railway/types";
import { ContainerDetailDialog } from "./container-detail-dialog";
import { DestroyContainerDialog } from "./destroy-container-dialog";
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
 * Everything a managed row can do to its container, plus the view of it that every row has.
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
  container,
  metrics,
  volume,
  state,
  projectId,
  environmentId,
  volumeSize,
}: {
  /**
   * The whole container rather than five fields off it.
   *
   * The detail dialog renders most of `Container`, so threading it field by field would be
   * a prop list that grows every time a fact is added to that view — and `container` is
   * what the row already holds.
   */
  container: Container;
  metrics: ContainerMetrics | undefined;
  volume: ContainerVolume | undefined;
  state: ContainerState;
  projectId: string;
  environmentId: string;
  /**
   * Formatted size of this container's volume, or undefined when it has none.
   *
   * Only destroy reads it. It rides through here rather than being looked up in the dialog
   * because the row already renders the same figure in its readout, and one formatter for
   * both is what keeps the two from disagreeing about the same volume.
   */
  volumeSize?: string;
}) {
  const actions = availableActions({
    state,
    deploymentId: container.deploymentId,
  });

  return (
    // Wraps as one unit rather than letting the row break between two of these controls.
    <div className="flex flex-wrap items-center justify-end gap-2">
      {/*
        Details rather than Edit, and it is not a rename: the control now opens a view of
        the container that a managed row can switch into an edit form. See
        container-detail-dialog.tsx for why the two are one thing.

        Not in `availableActions`, and not for want of a fourth entry. That list answers
        "would this mutation do anything in this state", which is a question about a running
        deployment — editing is a change to the container's *description*, and every state
        has one. The single exception is the state where the description is on its way out,
        which is what `disabled` says here: the details stay readable, the edit mode goes.
      */}
      <ContainerDetailDialog
        container={container}
        metrics={metrics}
        volume={volume}
        state={state}
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
          serviceId={container.serviceId}
          displayName={container.displayName}
          projectId={projectId}
          environmentId={environmentId}
        />
      ))}

      <DestroyContainerDialog
        serviceId={container.serviceId}
        displayName={container.displayName}
        projectId={projectId}
        environmentId={environmentId}
        volumeSize={volumeSize}
        disabled={state === "removing"}
      />
    </div>
  );
}
