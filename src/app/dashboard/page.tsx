import { Suspense } from "react";
import { redirect } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { CreateProjectDialog } from "@/components/create-dialogs";
import { ContainerSectionSkeleton } from "@/components/dashboard-skeletons";
import { ProjectPicker } from "@/components/project-picker";
import { ProjectWatcher } from "@/components/project-watcher";
import { RefreshButton } from "@/components/refresh-button";
import { SignInButton } from "@/components/sign-in-button";
import { SpinUpForm } from "@/components/spin-up-form";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ErrorBlock } from "@/components/ui/error-block";
import { EmptyState } from "@/components/ui/misc";
import { LINKS } from "@/lib/constants";
import { ContainerSection } from "./container-section";
import { deployRegions, loadDashboardShell, managedNames } from "./data";
import { PageMain } from "@/components/ui/page";
import { Heading } from "@/components/ui/text";

// The dashboard is a live view of Railway; caching it would show stale containers.
export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; environment?: string }>;
}) {
  const { project: projectParam, environment: environmentParam } = await searchParams;

  const shell = await loadDashboardShell({
    ...(projectParam ? { projectId: projectParam } : {}),
    ...(environmentParam ? { environmentId: environmentParam } : {}),
  });
  if (!shell) redirect("/");

  const t = await getTranslations("dashboard");
  const tCommon = await getTranslations("common");
  const tCreate = await getTranslations("createProject");
  const { projects, project, environment, error, errorKind, missingScopes } = shell;

  /*
   * Deliberately not awaited. The spin-up form checks a typed name against the names
   * already here, and awaiting that read would put the container round trip back in front
   * of the form — which is the latency the Suspense boundary below exists to remove. The
   * form resolves it in an effect instead, so it paints without it and gains the check a
   * moment later.
   *
   * The ids must be the same two strings `ContainerSection` passes below, or `cache` in
   * ./data.ts misses and this becomes a second Railway round trip rather than none. That
   * is also why an absent selection short-circuits here: `ContainerSection` returns before
   * its first await in that case, so there would be no read to share.
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

  /*
   * The empty list has two causes that need opposite advice. Without project access
   * Railway reports nothing no matter how many projects exist, and re-consent is the
   * only fix; with it, the list is genuinely empty and re-consent changes nothing —
   * which is the loop this page used to send people round.
   *
   * The create action belongs on exactly one side of this line. `projectCreate` is
   * refused by the same withheld scope that produced the empty list on the denied branch,
   * so offering it there would be a second button that cannot work; on the genuinely-empty
   * branch it is the only thing that changes anything, which is why that branch leads with
   * it and demotes the retry.
   */
  const deniedProjectAccess = missingScopes.some(
    (scope) => scope === "project:admin" || scope === "workspace:viewer",
  );

  /*
   * A failed project read means there is nothing to pick, nothing to spin up into and
   * nothing to list. The page used to render the whole interactive shell anyway —
   * `projects.length === 0 && !error` sent the failure case down the branch that draws
   * the pickers — so a broken authorization presented as an enabled Project dropdown
   * that opened an empty popup and explained nothing.
   *
   * Re-consent is offered only where it can help: a scope Railway withheld, or a
   * credential it rejected. A rate limit or an outage wants the retry, and pairing every
   * failure with a sign-in link is how "re-authorize" became the button that never works.
   */
  const reauthorizable = errorKind === "auth";

  /*
   * Two weights for the same escape hatch. On a plain card it is tertiary and stays
   * ghost; inside the tinted error block muted text on a danger surface reads as
   * disabled rather than quiet, so it takes the block's own weight.
   */
  const openRailwayLink = (
    <a href={LINKS.RAILWAY_DASHBOARD} target="_blank" rel="noreferrer">
      {t("openRailway")}
      <ExternalLink aria-hidden />
    </a>
  );
  const openRailway = (
    <Button asChild variant="ghost" size="sm">
      {openRailwayLink}
    </Button>
  );
  const openRailwayInError = (
    <Button asChild variant="danger" size="sm">
      {openRailwayLink}
    </Button>
  );

  return (
    <PageMain>
      {/*
        The page had no h1 at all — its highest heading was the container section's h2,
        so the document outline started at level two and the screen had no title.

        Invisible to every gate: axe's `page-has-heading-one` and `heading-order` are
        best-practice rules, and e2e/support.ts scans wcag tags only. The second scan
        added in this commit is what makes it stay fixed.

        Visually hidden rather than shown. The dashboard's subject is the project
        picker directly below, which names the project and environment far more usefully
        than a repeated app name would; a visible title here would be chrome restating
        what the next control already says. The outline and the screen-reader announce
        both need it to exist, which is what this does.
      */}
      <Heading level={1} className="sr-only">
        {t("title")}
      </Heading>
      {error ? (
        <ErrorBlock
          message={error}
          actions={
            reauthorizable ? (
              <>
                <SignInButton
                  label={t("reauthorize")}
                  consent
                  variant="danger"
                  size="sm"
                />
                {openRailwayInError}
              </>
            ) : (
              <>
                <RefreshButton
                  label={tCommon("retry")}
                  pendingLabel={t("retryPending")}
                  variant="danger"
                  size="sm"
                />
                {openRailwayInError}
              </>
            )
          }
        />
      ) : (
        <>
          {shell.partialError && <Banner tone="warning">{shell.partialError}</Banner>}

          {shell.droppedSelection && (
            <Banner tone="warning">{t("droppedSelection")}</Banner>
          )}

          {projects.length === 0 ? (
            <Card>
              <EmptyState
                title={
                  deniedProjectAccess ? t("noProjectsScopeTitle") : t("noProjectsTitle")
                }
                description={
                  deniedProjectAccess
                    ? t("noProjectsScopeDescription", {
                        scopes: missingScopes.join(", "),
                      })
                    : t("noProjectsDescription")
                }
                action={
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    {deniedProjectAccess ? (
                      <SignInButton
                        label={t("chooseProjects")}
                        consent
                        variant="primary"
                        size="sm"
                      />
                    ) : (
                      <>
                        {/*
                          The account is reachable and has nothing in it, so the useful
                          action is to put something in it. This used to lead with Check
                          again, which is the right answer only for the narrow case of a
                          project created elsewhere seconds ago — it stays, demoted.
                        */}
                        <CreateProjectDialog
                          variant="primary"
                          triggerLabel={tCreate("triggerFirst")}
                        />
                        {/* Asking Railway again is both cheaper and likelier to help
                              than a consent screen that already granted everything. */}
                        <RefreshButton
                          label={t("noProjectsRetry")}
                          pendingLabel={t("noProjectsRetryPending")}
                          variant="secondary"
                          size="sm"
                        />
                        <SignInButton
                          label={t("chooseProjects")}
                          consent
                          variant="ghost"
                          size="sm"
                        />
                      </>
                    )}
                    {openRailway}
                  </div>
                }
              />
            </Card>
          ) : (
            <>
              <ProjectPicker
                projects={projects}
                projectId={project?.id ?? null}
                environmentId={environment?.id ?? null}
              />

              {/*
                  Renders nothing. Holds the connection that notices a container created,
                  redeployed or destroyed in Railway's own dashboard — which this app used
                  to learn about only when the user pressed Refresh. Mounted here so a
                  project switch remounts it, and absent when there is nothing to watch.
                */}
              {project && environment && (
                <ProjectWatcher projectId={project.id} environmentId={environment.id} />
              )}

              <SpinUpForm
                projectId={project?.id ?? ""}
                environmentId={environment?.id ?? ""}
                disabled={!project || !environment}
                names={names}
                regions={regions}
              />

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

              searchParams stays {project, environment} for the same reason: widening it
              would say the server reads filters, and it must not.
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
            </>
          )}
        </>
      )}
    </PageMain>
  );
}
