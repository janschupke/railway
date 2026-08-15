import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ContainerSectionSkeleton } from "@/components/dashboard-skeletons";
import { ProjectWatcher } from "@/components/project-watcher";
import { ContainerSection } from "./container-section";
import { DashboardFrame } from "./dashboard-frame";
import { loadDashboardShell } from "./data-shell";

/**
 * The container list — the dashboard's index tab.
 *
 * The provisioning form and the billing readout used to be stacked on this same route and
 * are now `/dashboard/new` and `/dashboard/billing`. Everything the three share — the
 * heading, the failure states and the project picker — is DashboardFrame; the tab strip
 * that moves between them is in the layout. `dynamic = "force-dynamic"` is declared there
 * too, so all three views agree on it.
 */
export default async function DashboardPage({
  searchParams,
}: {
  /*
   * Stays {project, environment}, deliberately. The list's own filters (q, status, owner)
   * are applied on the client — Railway's project query accepts no filter arguments — and
   * widening this type would say the server reads them, which it must not. The tab strip
   * carries them between routes by reading the query on the client instead.
   */
  searchParams: Promise<{ project?: string; environment?: string }>;
}) {
  const { project: projectParam, environment: environmentParam } = await searchParams;

  // Passed through as-is: `?? ""` would be a different memo key from the other two tabs
  // and a second Railway round trip. See loadDashboardShell.
  const shell = await loadDashboardShell(projectParam, environmentParam);
  if (!shell) redirect("/");

  const t = await getTranslations("dashboard");
  const { project, environment } = shell;

  return (
    <DashboardFrame shell={shell}>
      {/*
        Renders nothing. Holds the connection that notices a container created,
        redeployed or destroyed in Railway's own dashboard — which this app used
        to learn about only when the user pressed Refresh. Mounted here so a
        project switch remounts it, and absent when there is nothing to watch.

        On this tab only, not in the frame. It exists to notice a change to the list on
        screen, and the other two tabs have no list — putting it in the frame would tear
        the SSE connection down and reopen it on every tab click, against
        WATCH.MAX_CONCURRENT_PER_USER, with an overlap during the transition.
      */}
      {project && environment && (
        <ProjectWatcher projectId={project.id} environmentId={environment.id} />
      )}

      {/*
        Keyed on the selection, not merely wrapped. React only reveals a fallback
        for a boundary it is mounting fresh; an update to a boundary that is
        already showing content suspends without committing, which is why
        switching projects used to hold the previous project's rows on screen for
        both Railway round trips.

        The key must be on <Suspense> itself — keying the child remounts it under
        the same boundary fiber, which is the no-commit path again and looks
        identical in review. e2e/skeleton.spec.ts asserts the old rows are gone,
        which is the only thing that catches it.

        A router.refresh() keeps the same key, so it deliberately does NOT blank
        the list; those call sites surface their own pending state instead.

        The list's own filters (q, status, owner) are deliberately NOT in this key,
        and adding them is the plausible-looking change to resist. They are applied
        on the client — Railway's project query accepts no filter arguments, so the
        server would only recompute the same answer — which means a filter change
        re-runs nothing here and has nothing to suspend on. Keying on them would
        blank the whole list behind a skeleton on every keystroke instead.
      */}
      <Suspense
        key={`${project?.id ?? ""}:${environment?.id ?? ""}`}
        fallback={<ContainerSectionSkeleton heading={t("containersHeading")} />}
      >
        <ContainerSection
          projectId={project?.id ?? null}
          environmentId={environment?.id ?? null}
        />
      </Suspense>
    </DashboardFrame>
  );
}
