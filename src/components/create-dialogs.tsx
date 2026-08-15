"use client";

import { useTranslations } from "next-intl";
import { createEnvironment, createProject } from "@/app/dashboard/actions";
import { useDashboardSelection } from "@/hooks/use-dashboard-selection";
import type { RailwayWorkspace } from "@/lib/railway/types";
import {
  CreateNameDialog,
  type CreateNameChoice,
  type CreateNameCopy,
} from "./create-name-dialog";
import { PendingStatus } from "./ui/misc";

/**
 * The nine strings the dialog needs, read out of whichever namespace the caller holds.
 *
 * `createProject` and `createEnvironment` are separate namespaces carrying the same key
 * names, so both call sites resolved the same nine keys and differed only in the `t` they
 * passed. Adding a tenth string to the dialog used to mean editing two identical blocks,
 * and the one that got missed would have been a `undefined` rendered as copy.
 */
function copyFor(
  t: (key: keyof CreateNameCopy) => string,
  overrides: Partial<CreateNameCopy> = {},
): CreateNameCopy {
  const keys: Array<keyof CreateNameCopy> = [
    "trigger",
    "title",
    "description",
    "label",
    "placeholder",
    "submit",
    "submitPending",
    "announce",
    "failedTitle",
  ];
  return Object.fromEntries(
    keys.map((key) => [key, overrides[key] ?? t(key)]),
  ) as CreateNameCopy;
}

/**
 * "New project", wherever it appears.
 *
 * Two call sites with two shapes now. In the empty state it draws its own primary button,
 * because creating a project is the whole point of that screen. In the picker it is
 * controlled and draws nothing — the affordance is a row inside the project dropdown, next
 * to the projects it would be added to.
 *
 * Not `…Button` any more, for that reason: at one of its call sites it is not one.
 *
 * Owns the navigation because the value of creating a project here — rather than on
 * railway.com — is landing on it. `useDashboardSelection` is what actually writes the URL;
 * this only decides that a create should select what it made.
 */
export function CreateProjectDialog({
  variant = "secondary",
  triggerLabel,
  workspaces,
  deniedWorkspaces,
  open,
  onOpenChange,
}: {
  variant?: "primary" | "secondary";
  /** Overridden in the empty state, where the button is a first-run invitation. */
  triggerLabel?: string;
  /** Where this project could go besides the personal account. */
  workspaces: RailwayWorkspace[];
  /** True when the list above is empty because Railway withheld `workspace:viewer`. */
  deniedWorkspaces: boolean;
  /** Supplied, the trigger is the caller's. See CreateNameDialog. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useTranslations("createProject");
  const { select, pending } = useDashboardSelection();

  /*
   * Three states, and the middle one is the reason this is not a ternary in the JSX.
   *
   * With workspaces, the personal account leads the list as the blank option — the same
   * shape advanced-settings.tsx builds its region list in, and what keeps today's behaviour
   * the default rather than changing it silently.
   *
   * With none because the scope was withheld, the control is drawn with nothing in it,
   * which is what makes `Select` inert and puts the reason under it. A reader who works out
   * of a workspace is otherwise told nothing about why their project went elsewhere.
   *
   * With none because there are none, there is no choice to make and nothing is drawn.
   */
  const choice: CreateNameChoice | undefined =
    workspaces.length > 0
      ? {
          name: "workspaceId",
          label: t("workspaceLabel"),
          options: [
            { value: "", label: t("workspacePersonal") },
            ...workspaces.map((workspace) => ({
              value: workspace.id,
              label: workspace.name,
            })),
          ],
        }
      : deniedWorkspaces
        ? {
            name: "workspaceId",
            label: t("workspaceLabel"),
            options: [],
            disabledReason: t("workspaceUnavailable"),
          }
        : undefined;

  return (
    <>
      <CreateNameDialog
        action={createProject}
        field="projectName"
        triggerVariant={variant}
        {...(choice ? { choice } : {})}
        {...(open === undefined ? {} : { open })}
        {...(onOpenChange ? { onOpenChange } : {})}
        copy={copyFor(t, { trigger: triggerLabel })}
        onCreated={(selection) => {
          if (selection) select(selection.projectId, selection.environmentId);
        }}
      />
      <PendingStatus className="sr-only" label={pending ? t("opening") : undefined} />
    </>
  );
}

/**
 * "New environment", as a row inside the environment picker.
 *
 * The "disabled rather than hidden" rule that used to live here now lives in the control
 * itself, which is where it belongs: without a project the environment Select is disabled
 * and says `selectProjectFirst` under it, so the row is unreachable and the reason is on
 * screen. With a project and no environments the Select stays *enabled* holding one row —
 * the thing that fixes the emptiness is not a dead end.
 */
export function CreateEnvironmentDialog({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useTranslations("createEnvironment");
  const { select, pending } = useDashboardSelection();

  return (
    <>
      <CreateNameDialog
        action={createEnvironment}
        field="environmentName"
        disabled={!projectId}
        {...(projectId ? { hidden: { projectId } } : {})}
        {...(open === undefined ? {} : { open })}
        {...(onOpenChange ? { onOpenChange } : {})}
        copy={copyFor(t)}
        onCreated={(selection) => {
          if (selection) select(selection.projectId, selection.environmentId);
        }}
      />
      <PendingStatus className="sr-only" label={pending ? t("opening") : undefined} />
    </>
  );
}
