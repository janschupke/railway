import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { SpinUpForm } from "@/components/spin-up-form";
import { Heading } from "@/components/ui/text";
import { managedNames } from "../data-containers";
import { deployRegions } from "../data-regions";
import { loadDashboardShell } from "../data-shell";
import { DashboardFrame } from "../dashboard-frame";

/**
 * Creating a container — the dashboard's provisioning tab.
 *
 * Split off `/dashboard` so the form is not the first thing between a reader and their
 * container list. A successful create hops back to that tab, where the new row and its
 * streaming build logs are; see `goToContainers` in use-dashboard-selection.ts.
 *
 * `dynamic = "force-dynamic"` is declared on the shared layout, not here.
 */
export default async function NewContainerPage({
  searchParams,
}: {
  /** Same two keys as the other tabs, for the reason page.tsx gives. */
  searchParams: Promise<{ project?: string; environment?: string }>;
}) {
  const { project: projectParam, environment: environmentParam } = await searchParams;

  const shell = await loadDashboardShell(projectParam, environmentParam);
  if (!shell) redirect("/");

  const t = await getTranslations("dashboard");
  const { project, environment } = shell;

  /*
   * Deliberately not awaited. The spin-up form checks a typed name against the names
   * already here, and awaiting that read would put a container round trip in front of the
   * form — which is the whole reason it resolves this in an effect instead, painting
   * without it and gaining the check a moment later.
   *
   * **It no longer shares a memo with anything, and that is a real cost.** While the form
   * and the container list were the same route, this read through `containerList`'s
   * `cache()` alongside ContainerSection and the pair was one Railway round trip. On this
   * tab there is no list, so it pays for the whole loader by itself: the container read,
   * plus the metrics and volume reads issued beside it, two of which nothing here renders.
   *
   * Accepted rather than optimised away. It is unawaited so it blocks no paint, it is once
   * per render rather than per keystroke, and the tab links are `prefetch={false}` so it
   * never fires for someone who does not open this tab. A metrics-free path for this one
   * caller would break the "one subject" argument data-containers.ts is built around, and
   * it should be argued for on a measurement rather than on this comment.
   */
  const names =
    project && environment
      ? managedNames(project.id, environment.id)
      : Promise.resolve([]);

  /*
   * Not awaited either, for the same reason and with one difference worth naming: this read
   * shares no memo with anything on the page, so it is a Railway round trip of its own —
   * memoised for ten minutes in lib/railway/regions.ts, which is what stops a select nobody
   * opens costing a request per render.
   *
   * Keyed on the project alone. Regions are a project-scoped list, and including the
   * environment would halve the memo's hit rate for a value it does not depend on.
   */
  const regions = project ? deployRegions(project.id) : Promise.resolve([]);

  return (
    <DashboardFrame shell={shell}>
      <section className="space-y-2">
        {/*
          A real heading, unlike the container tab's, which the list owns. The form is the
          only thing on this route, so without one the tab's content starts at a card with
          no name in the outline — and the h1 above is generic by design.
        */}
        <Heading level={2}>{t("newHeading")}</Heading>

        <SpinUpForm
          projectId={project?.id ?? ""}
          environmentId={environment?.id ?? ""}
          disabled={!project || !environment}
          names={names}
          regions={regions}
        />
      </section>
    </DashboardFrame>
  );
}
