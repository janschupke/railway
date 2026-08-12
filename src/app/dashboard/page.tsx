import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ContainerSectionSkeleton } from "@/components/dashboard-skeletons";
import { DashboardHeader } from "@/components/dashboard-header";
import { ProjectPicker } from "@/components/project-picker";
import { SignInButton } from "@/components/sign-in-button";
import { SpinUpForm } from "@/components/spin-up-form";
import { Banner } from "@/components/ui/banner";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
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
  const { projects, project, environment, error } = shell;

  return (
    <>
      <DashboardHeader {...shell.user} />

      <main className="mx-auto w-full max-w-4xl flex-1 space-y-6 p-6">
        {error && <Banner tone="error">{error}</Banner>}

        {projects.length === 0 && !error ? (
          <Card>
            <EmptyState
              title={t("noProjectsTitle")}
              description={t("noProjectsDescription")}
              action={
                <SignInButton
                  label={t("chooseProjects")}
                  variant="secondary"
                  size="sm"
                />
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
