import { Suspense } from "react";
import { redirect } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { ContainerSectionSkeleton } from "@/components/dashboard-skeletons";
import { DashboardHeader } from "@/components/dashboard-header";
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
import { loadDashboardShell } from "./data";

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
  const { projects, project, environment, error, errorKind, missingScopes } = shell;

  /*
   * The empty list has two causes that need opposite advice. Without project access
   * Railway reports nothing no matter how many projects exist, and re-consent is the
   * only fix; with it, the list is genuinely empty and re-consent changes nothing —
   * which is the loop this page used to send people round.
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
    <>
      <DashboardHeader {...shell.user} />

      <main className="mx-auto w-full max-w-4xl flex-1 space-y-6 p-6">
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
                    deniedProjectAccess
                      ? t("noProjectsScopeTitle")
                      : t("noProjectsTitle")
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
                          {/* Asking Railway again is both cheaper and likelier to help
                              than a consent screen that already granted everything. */}
                          <RefreshButton
                            label={t("noProjectsRetry")}
                            pendingLabel={t("noProjectsRetryPending")}
                            variant="primary"
                            size="sm"
                          />
                          <SignInButton
                            label={t("chooseProjects")}
                            consent
                            variant="secondary"
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
                  <ProjectWatcher
                    projectId={project.id}
                    environmentId={environment.id}
                  />
                )}

                <SpinUpForm
                  projectId={project?.id ?? ""}
                  environmentId={environment?.id ?? ""}
                  disabled={!project || !environment}
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
            */}
                <Suspense
                  key={`${project?.id ?? ""}:${environment?.id ?? ""}`}
                  fallback={
                    <ContainerSectionSkeleton heading={t("containersHeading")} />
                  }
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
      </main>
    </>
  );
}
