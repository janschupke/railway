import { Suspense } from "react";
import { redirect } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { ContainerSectionSkeleton } from "@/components/dashboard-skeletons";
import { DashboardHeader } from "@/components/dashboard-header";
import { ProjectPicker } from "@/components/project-picker";
import { RefreshButton } from "@/components/refresh-button";
import { SignInButton } from "@/components/sign-in-button";
import { SpinUpForm } from "@/components/spin-up-form";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
  const deniedProjectAccess = missingScopes.includes("project:admin");

  const openRailway = (
    <Button asChild variant="ghost" size="sm">
      <a href={LINKS.RAILWAY_DASHBOARD} target="_blank" rel="noreferrer">
        {t("openRailway")}
        <ExternalLink aria-hidden />
      </a>
    </Button>
  );

  return (
    <>
      <DashboardHeader {...shell.user} />

      <main className="mx-auto w-full max-w-4xl flex-1 space-y-6 p-6">
        {error && (
          <div className="space-y-2">
            <Banner tone="error">{error}</Banner>
            <div className="flex flex-wrap gap-2">
              <RefreshButton
                label={tCommon("retry")}
                pendingLabel={t("retryPending")}
                variant="secondary"
                size="sm"
              />
              {/* Re-consent is offered only where it can help. A rate limit or an
                  outage wants the retry above; pairing every failure with a sign-in
                  link is how "re-authorize" became the button that never works. */}
              {errorKind === "auth" && (
                <SignInButton label={t("reauthorize")} variant="secondary" size="sm" />
              )}
            </div>
          </div>
        )}

        {shell.droppedSelection && (
          <Banner tone="warning">{t("droppedSelection")}</Banner>
        )}

        {projects.length === 0 && !error ? (
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
              fallback={<ContainerSectionSkeleton heading={t("containersHeading")} />}
            >
              <ContainerSection
                projectId={project?.id ?? null}
                environmentId={environment?.id ?? null}
              />
            </Suspense>
          </>
        )}
      </main>
    </>
  );
}
