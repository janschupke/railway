"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useDashboardSelection } from "@/hooks/use-dashboard-selection";
import type { RailwayProject, RailwayWorkspace } from "@/lib/railway/types";
import { CreateEnvironmentDialog, CreateProjectDialog } from "./create-dialogs";
import { PendingStatus } from "./ui/misc";
import { Select } from "./ui/select";

/**
 * Selection lives in the URL rather than component state, so the dashboard is
 * linkable, survives a refresh, and lets the server do the fetching.
 *
 * The writing of it moved to useDashboardSelection when the create dialogs arrived —
 * see that file for why one place owns the rules.
 */
/** Which create dialog is showing, if either. */
type Creating = typeof PROJECT | typeof ENVIRONMENT | null;
const PROJECT = "project";
const ENVIRONMENT = "environment";

export function ProjectPicker({
  projects,
  projectId,
  environmentId,
  workspaces,
  deniedWorkspaces,
}: {
  projects: RailwayProject[];
  projectId: string | null;
  environmentId: string | null;
  /** Passed straight through to the create dialog; this control does not read them. */
  workspaces: RailwayWorkspace[];
  deniedWorkspaces: boolean;
}) {
  const t = useTranslations("dashboard");
  const tProject = useTranslations("createProject");
  const tEnvironment = useTranslations("createEnvironment");
  const { selectProject, selectEnvironment, pending } = useDashboardSelection();
  /*
   * Which create dialog is open, if either. One piece of state rather than two booleans
   * because they are mutually exclusive by construction — both are opened from a dropdown,
   * and a dropdown has to close before its dialog opens.
   */
  const [creating, setCreating] = useState<Creating>(null);

  /*
   * Bound here rather than inline in the JSX, for the reason advanced-settings.tsx states:
   * the i18n lint rule reads every string literal in JSX as user-facing copy, and a
   * discriminant is indistinguishable to it from a sentence. Widening its allowlist is the
   * fix the rules explicitly refuse.
   */
  const openCreate = (which: Exclude<Creating, null>) => () => setCreating(which);

  /*
   * Focus goes back to the dropdown the create row was chosen from.
   *
   * Radix restores a dialog's focus to its `DialogTrigger`, and a controlled one renders
   * none — so without this it lands on `<body>` and a keyboard user is dropped at the top
   * of the document, having been two keystrokes deep in a control. The Select trigger is
   * where they were and where the thing they just created now appears.
   *
   * One frame later, for the mirror image of the reason the create row waits a frame
   * before opening this dialog: `onOpenChange` fires before the dialog's own focus scope
   * unmounts, and that teardown would undo a synchronous focus.
   *
   * Two handlers rather than one parameterised by a ref, because `react-hooks/refs`
   * refuses a ref that crosses a function boundary at render time — and it is right that
   * a ref chosen by a ternary is harder to read than two closures that each name one.
   */
  const projectTrigger = useRef<HTMLButtonElement>(null);
  const environmentTrigger = useRef<HTMLButtonElement>(null);

  const trackProject = (open: boolean) => {
    setCreating(open ? PROJECT : null);
    if (!open) requestAnimationFrame(() => projectTrigger.current?.focus());
  };

  const trackEnvironment = (open: boolean) => {
    setCreating(open ? ENVIRONMENT : null);
    if (!open) requestAnimationFrame(() => environmentTrigger.current?.focus());
  };

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
        {/*
          The create row lives in the list it adds to, rather than as a button after the
          pair. Two reasons, and the second is the one that decided it: a reader finds out
          their project is not here BY LOOKING AT THIS LIST, so the answer belongs where
          they already are — and the buttons that used to sit after these two selects made
          a control row of four things, half of which were not the choice being made.
        */}
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
          triggerRef={projectTrigger}
          action={{
            label: tProject("trigger"),
            onSelect: openCreate(PROJECT),
          }}
        />
      </div>

      <div className="w-64">
        <Select
          label={t("environmentLabel")}
          value={environmentId ?? undefined}
          disabled={!selected}
          /* Only one reason left to be dim. The other state — a project whose environment
             list is empty — is no longer a dead control: it holds the row that fixes it. */
          disabledReason={t("selectProjectFirst")}
          {...(selected && selected.environments.length === 0
            ? { hint: t("noEnvironments") }
            : {})}
          options={
            selected?.environments.map((e) => ({ value: e.id, label: e.name })) ?? []
          }
          onValueChange={selectEnvironment}
          triggerRef={environmentTrigger}
          /* Without a project there is nothing to create an environment in, so the row is
             not offered at all — and the control it would have lived in says why. */
          {...(selected
            ? {
                action: {
                  label: tEnvironment("trigger"),
                  onSelect: openCreate(ENVIRONMENT),
                },
              }
            : {})}
        />
      </div>

      <PendingStatus label={pending ? t("switchingProject") : undefined} />

      {/*
        Outside the row's flex children: these render no trigger of their own, so a
        wrapper here would be an empty box taking a gap.
      */}
      <CreateProjectDialog
        workspaces={workspaces}
        deniedWorkspaces={deniedWorkspaces}
        open={creating === PROJECT}
        onOpenChange={trackProject}
      />
      <CreateEnvironmentDialog
        projectId={projectId}
        open={creating === ENVIRONMENT}
        onOpenChange={trackEnvironment}
      />
    </div>
  );
}
