"use client";

import { useTranslations } from "next-intl";
import { useDashboardSelection } from "@/hooks/use-dashboard-selection";
import type { RailwayProject } from "@/lib/railway/types";
import { CreateEnvironmentButton, CreateProjectButton } from "./create-project-button";
import { PendingStatus } from "./ui/misc";
import { Select } from "./ui/select";

/**
 * Selection lives in the URL rather than component state, so the dashboard is
 * linkable, survives a refresh, and lets the server do the fetching.
 *
 * The writing of it moved to useDashboardSelection when the create dialogs arrived —
 * see that file for why one place owns the rules.
 */
export function ProjectPicker({
  projects,
  projectId,
  environmentId,
}: {
  projects: RailwayProject[];
  projectId: string | null;
  environmentId: string | null;
}) {
  const t = useTranslations("dashboard");
  const { selectProject, selectEnvironment, pending } = useDashboardSelection();

  const selected = projects.find((p) => p.id === projectId);

  return (
    /*
     * The selects stay enabled while the route transition runs. Disabling the control
     * the user just committed removes it from the a11y tree and drops focus to <body>;
     * aria-busy says the same thing without stealing focus, and React supersedes the
     * earlier navigation if they change their mind mid-flight.
     */
    // items-end, because each Select now carries a visible label above its trigger and
    // an optional reason below it — centring would stagger the triggers themselves.
    <div className="flex flex-wrap items-end gap-3" aria-busy={pending || undefined}>
      {/*
        A fixed column rather than `grow`. The triggers used to size to their content, so
        the row rearranged itself whenever the selection changed — and `grow` would keep
        it moving, since the pending status beside them appears and disappears. w-64 is
        wide enough for a real project name and narrow enough that two of them still read
        as a control row rather than a form.
      */}
      <div className="w-64">
        <Select
          label={t("projectLabel")}
          value={projectId ?? undefined}
          disabledReason={t("noProjectsAvailable")}
          options={projects.map((p) => ({
            value: p.id,
            label: p.name,
            // Only projects reached through a workspace carry one, so an account whose
            // projects are all personal gets an ungrouped list exactly as before.
            ...(p.workspaceName ? { group: p.workspaceName } : {}),
          }))}
          onValueChange={selectProject}
        />
      </div>

      <div className="w-64">
        <Select
          label={t("environmentLabel")}
          value={environmentId ?? undefined}
          disabled={!selected}
          /* Two different reasons for the same greyed-out control, and the user can act
             on one of them. Saying neither made this look broken rather than empty. */
          disabledReason={selected ? t("noEnvironments") : t("selectProjectFirst")}
          options={
            selected?.environments.map((e) => ({ value: e.id, label: e.name })) ?? []
          }
          onValueChange={selectEnvironment}
        />
      </div>

      {/*
        After the two selects, not between them. These add to what the selects choose
        from, and putting a button in the middle of the pair would break the reading order
        of the two controls that belong together.
      */}
      <div className="flex flex-wrap items-center gap-2">
        <CreateProjectButton />
        <CreateEnvironmentButton projectId={projectId} />
      </div>

      <PendingStatus label={pending ? t("switchingProject") : undefined} />
    </div>
  );
}
