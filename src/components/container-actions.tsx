"use client";

import { useRef, useState, useTransition } from "react";
import {
  ExternalLink,
  Info,
  MoreHorizontal,
  Play,
  RotateCcw,
  Square,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
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
import { RailwayServiceLink } from "./railway-service-link";
import { Button } from "./ui/button";
import {
  DropdownMenuContent,
  DropdownMenuDestructiveItem,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

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

/** Which dialog the menu opened, or null for none. Destroy and details are their own. */
type OpenDialog = ContainerAction | "details" | "destroy" | null;

/**
 * Everything a row can do to its container, behind one `…` trigger.
 *
 * ## Why a menu
 *
 * These were four to six controls in a row: Details, up to two lifecycle verbs, Destroy —
 * and every one of them a Radix trigger with an icon and a label. `container-url.tsx`'s
 * docblock had already named the pressure — *"the cluster is at four controls on a running
 * managed row before anything else is added to it"* — and the cluster was the noisiest thing
 * on a screen whose subject is a list of container names. One trigger per row is the shape
 * that stops the actions competing with the thing they act on.
 *
 * `multi-select.tsx` rejected DropdownMenu for the status filter and its reasoning is the
 * argument for it here: *"A menu is a list of commands … its arrow-key model exists because
 * a menu closes when you pick something."* A row's actions are exactly that.
 *
 * ## What did NOT move
 *
 * The log disclosure chevron, the selection checkbox and the name link stay on the row: none
 * is a command, and two of them are how a reader gets at the row's content rather than acts
 * on it. **"Add a public URL" also stays**, in the name block beside the address it creates —
 * `container-url.tsx` argues for that on position rather than on crowding ("this line is the
 * container's address … a row that could have one offers it, in the place the reader is
 * already looking for it"), and the menu answers the crowding half only. Rollback stays in
 * the expanded history panel, where it belongs to an entry rather than to the container.
 *
 * ## The rules the menu keeps
 *
 * **Never render-and-disable a lifecycle verb.** `availableActions` is unchanged and the
 * menu renders exactly what it returns — absent items, not dimmed ones. A disabled control
 * is a promise that something would happen if only the row were in another state, and
 * "Restart" on a container that is still building is not a promise this app can keep.
 *
 * **Destroy is last and separated**, and it is the one item that carries a colour. The
 * separator is not decoration: it is what stops a pointer travelling down the list from
 * landing on Destroy at the end of the same gesture that opened the menu.
 *
 * **This component writes no appearance.** Every class lives in `ui/dropdown-menu.tsx`.
 *
 * ## Two things this arrangement forced
 *
 * **The dialogs are siblings of the menu, opened by state.** A trigger rendered inside a
 * menu item unmounts the moment the menu closes, which breaks both the open and the focus
 * restore — so all three dialogs grew an opt-in controlled `open` and a `hideTrigger`, and
 * each states why at its own definition.
 *
 * **One refresh transition, held here.** Each dialog used to own the window between "the
 * action returned" and "the refreshed list arrived", and marked its own trigger busy for the
 * duration. There is one trigger now, and it belongs to no dialog — so the transition moved
 * up, and every verb on the row runs its refresh through it. That is what keeps
 * `e2e/skeleton.spec.ts`'s guarantee true: its comment records the bug it prevents — *"Its
 * trigger used to stay live, and a second click hit a service that no longer existed."*
 *
 * `state` is the row's live value, preferring the stream over the last server render, so the
 * items change with the badge rather than a refresh behind it.
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
  const t = useTranslations("containers");
  const tDetail = useTranslations("containerDetail");
  const tLifecycle = useTranslations("lifecycle");
  const tDestroy = useTranslations("destroy.one");

  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  /*
   * The one refresh window for every verb on this row — see the docblock above.
   *
   * `Button` derives `aria-busy` and `disabled` from `pending`, so marking the trigger is
   * the whole of it: while a stale list is on screen, nothing in this menu can be reached,
   * because the menu itself cannot be opened.
   */
  const [refreshing, startRefresh] = useTransition();

  /**
   * Closes the menu, then opens the dialog one frame later.
   *
   * The delay is the whole reason this is not `setDialog(which)` in the handler. A menu is a
   * modal layer: it holds a scroll lock, puts `aria-hidden` on every sibling of its portal,
   * sets `pointer-events: none` on the body, and restores focus to its trigger. All of that
   * unwinds in the commit `setMenuOpen(false)` schedules — which React flushes at the end of
   * this discrete event, so by the frame callback the layer is genuinely gone. Opening a
   * dialog any sooner is two modal layers racing each other's teardown: it mounts under a
   * body that still refuses pointer events, and the menu's focus restore pulls focus
   * straight back out of it.
   *
   * This is `select.tsx`'s `requestAction`, verbatim in shape, and for the same reason.
   *
   * Note what is deliberately NOT done: `onCloseAutoFocus` is left alone. Letting the
   * restore run means the `…` trigger is `document.activeElement` when the dialog mounts, so
   * the dialog's own focus scope records it and returns focus there on close — which is what
   * `e2e/keyboard.spec.ts` asserts, for free and with no `returnFocus` threaded anywhere.
   */
  const openDialog = (which: Exclude<OpenDialog, null>) => {
    setMenuOpen(false);
    requestAnimationFrame(() => setDialog(which));
  };

  /**
   * Closes the dialog and puts focus back on the `…` trigger.
   *
   * The restore is explicit, and the first draft of this assumed it would not have to be —
   * `select.tsx` gets it free, because letting the popup's own restore run leaves its
   * trigger as `document.activeElement` when the dialog mounts, so the dialog's focus scope
   * records it and returns there on close.
   *
   * That does not hold here, and it was measured rather than reasoned: the menu's restore
   * has not run by the time the dialog mounts a frame later, so the dialog records the body
   * and returns focus to the body — a keyboard user closing a dialog is dropped at the top
   * of the document, halfway down a list of containers.
   *
   * A frame later than the close, for the same reason `openDialog` waits one: the dialog's
   * own restore runs during its unmount commit and would otherwise overwrite this.
   */
  const closeDialog = () => {
    setDialog(null);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const actions = availableActions({
    state,
    deploymentId: container.deploymentId,
  });

  /*
   * An unmanaged row gets the same menu with two items, rather than the two bare controls it
   * used to carry. One shape for the whole column: a reader scanning down it should not have
   * to work out why some rows end in a `…` and others in a pair of buttons.
   *
   * What it may do is unchanged — Details, and Railway's own page — and that is the point.
   * `withManagedContainer` refuses every verb on the server whatever the browser sends, and
   * a menu that offered a greyed-out Destroy would be promising a state that does not exist.
   */
  const canAct = container.managed;
  const removing = state === "removing";

  return (
    <div className="flex items-center justify-end">
      <DropdownMenuRoot open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          {/*
            `secondary`, not `ghost`. `button.tsx` nominates ghost for "an inline menu
            trigger", and that would be right for a menu of conveniences — but this is now
            the only way to reach Destroy, which is the argument `multi-select.tsx` used to
            pick secondary for a control that is the only route to a whole capability.

            No visible label, so no WCAG 2.5.3 conflict — but the name has to say which row,
            because a list of these all read "Actions" otherwise. Same shape `toggleLogs`
            uses for the disclosure beside it. No tooltip: `ui/tooltip.tsx` exposes no
            controlled `open`, so one here would float beside the menu it just opened.
          */}
          <Button
            variant="secondary"
            size="sm"
            pending={refreshing}
            pendingLabel={tLifecycle("refreshPending")}
            aria-label={t("rowActions", { name: container.displayName })}
            ref={triggerRef}
          >
            <MoreHorizontal aria-hidden />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent label={t("rowActions", { name: container.displayName })}>
          <DropdownMenuItem onSelect={() => openDialog("details")}>
            <Info aria-hidden />
            {tDetail("trigger")}
          </DropdownMenuItem>

          {/*
            An anchor rather than a dialog, so it is `asChild` on the item: the menu closes
            on select either way, and this one navigates instead of opening a layer, so it
            needs none of `openDialog`'s frame dance.
          */}
          <DropdownMenuItem asChild>
            <RailwayServiceLink
              projectId={projectId}
              serviceId={container.serviceId}
              environmentId={environmentId}
            >
              <ExternalLink aria-hidden />
              {t("openInRailway")}
            </RailwayServiceLink>
          </DropdownMenuItem>

          {canAct && actions.length > 0 && (
            <>
              <DropdownMenuSeparator />
              {actions.map((action) => (
                <DropdownMenuItem key={action} onSelect={() => openDialog(action)}>
                  {ACTIONS[action].icon}
                  {tLifecycle(`${action}.trigger`)}
                </DropdownMenuItem>
              ))}
            </>
          )}

          {canAct && !removing && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuDestructiveItem onSelect={() => openDialog("destroy")}>
                <Trash2 aria-hidden />
                {tDestroy("trigger")}
              </DropdownMenuDestructiveItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenuRoot>

      {/*
        The dialogs, as siblings of the menu rather than inside it — see the docblock. Each
        renders no trigger and takes its open state from here.

        Details is offered on every row, managed or not, and this is the row it was missing
        most before it existed: an external container had nowhere to show what the app knew
        about it. `disabled` is what closes its edit mode on a container that is on its way
        out; the facts stay readable.
      */}
      <ContainerDetailDialog
        container={container}
        metrics={metrics}
        volume={volume}
        state={state}
        projectId={projectId}
        environmentId={environmentId}
        disabled={removing}
        hideTrigger
        open={dialog === "details"}
        onOpenChange={(next) => !next && closeDialog()}
        startRefresh={startRefresh}
      />

      {canAct &&
        actions.map((action) => (
          <LifecycleActionDialog
            key={action}
            action={action}
            run={ACTIONS[action].run}
            icon={ACTIONS[action].icon}
            serviceId={container.serviceId}
            displayName={container.displayName}
            projectId={projectId}
            environmentId={environmentId}
            hideTrigger
            open={dialog === action}
            onOpenChange={(next) => !next && closeDialog()}
            startRefresh={startRefresh}
          />
        ))}

      {canAct && (
        <DestroyContainerDialog
          serviceId={container.serviceId}
          displayName={container.displayName}
          projectId={projectId}
          environmentId={environmentId}
          volumeSize={volumeSize}
          disabled={removing}
          hideTrigger
          open={dialog === "destroy"}
          onOpenChange={(next) => !next && closeDialog()}
          startRefresh={startRefresh}
        />
      )}
    </div>
  );
}
