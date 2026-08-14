"use client";

import { useTranslations } from "next-intl";
import { createEnvironment, createProject } from "@/app/dashboard/actions";
import { useDashboardSelection } from "@/hooks/use-dashboard-selection";
import { CreateNameDialog } from "./create-name-dialog";
import { PendingStatus } from "./ui/misc";

/**
 * "New project", wherever it appears.
 *
 * Two call sites with two weights: primary in the empty state, where creating one is the
 * whole point of the screen, and secondary beside the picker, where it sits next to the
 * thing it adds to. The behaviour is identical, which is why it is one component with a
 * variant rather than two.
 *
 * Owns the navigation because the value of creating a project here — rather than on
 * railway.com — is landing on it. `useDashboardSelection` is what actually writes the URL;
 * this only decides that a create should select what it made.
 */
export function CreateProjectButton({
  variant = "secondary",
  triggerLabel,
}: {
  variant?: "primary" | "secondary";
  /** Overridden in the empty state, where the button is a first-run invitation. */
  triggerLabel?: string;
}) {
  const t = useTranslations("createProject");
  const { select, pending } = useDashboardSelection();

  return (
    <>
      <CreateNameDialog
        action={createProject}
        field="projectName"
        triggerVariant={variant}
        copy={{
          trigger: triggerLabel ?? t("trigger"),
          title: t("title"),
          description: t("description"),
          label: t("label"),
          placeholder: t("placeholder"),
          submit: t("submit"),
          submitPending: t("submitPending"),
          announce: t("announce"),
          failedTitle: t("failedTitle"),
        }}
        onCreated={(selection) => {
          if (selection) select(selection.projectId, selection.environmentId);
        }}
      />
      <PendingStatus className="sr-only" label={pending ? t("opening") : undefined} />
    </>
  );
}

/**
 * "New environment", beside the environment picker.
 *
 * Disabled without a project rather than hidden — the control is part of the row's shape,
 * and a button that appears once you pick something is harder to find than one that was
 * always there. The reason is said out loud for the same reason the environment Select
 * carries a `disabledReason`.
 */
export function CreateEnvironmentButton({ projectId }: { projectId: string | null }) {
  const t = useTranslations("createEnvironment");
  const { select, pending } = useDashboardSelection();

  return (
    <>
      <CreateNameDialog
        action={createEnvironment}
        field="environmentName"
        disabled={!projectId}
        {...(projectId ? { hidden: { projectId } } : {})}
        copy={{
          trigger: t("trigger"),
          title: t("title"),
          description: t("description"),
          label: t("label"),
          placeholder: t("placeholder"),
          submit: t("submit"),
          submitPending: t("submitPending"),
          announce: t("announce"),
          failedTitle: t("failedTitle"),
        }}
        onCreated={(selection) => {
          if (selection) select(selection.projectId, selection.environmentId);
        }}
      />
      <PendingStatus className="sr-only" label={pending ? t("opening") : undefined} />
    </>
  );
}
