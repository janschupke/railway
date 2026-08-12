import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ContainerRow } from "@/components/container-row";
import { DashboardHeader } from "@/components/dashboard-header";
import { ProjectPicker } from "@/components/project-picker";
import { SignInButton } from "@/components/sign-in-button";
import { SpinUpForm } from "@/components/spin-up-form";
import { Banner } from "@/components/ui/banner";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
import { managedPrefix } from "@/lib/railway/managed";
import { loadDashboard } from "./data";

// The dashboard is a live view of Railway; caching it would show stale containers.
export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; environment?: string }>;
}) {
  const { project: projectParam, environment: environmentParam } = await searchParams;

  const data = await loadDashboard({
    ...(projectParam ? { projectId: projectParam } : {}),
    ...(environmentParam ? { environmentId: environmentParam } : {}),
  });
  if (!data) redirect("/");

  const t = await getTranslations("dashboard");
  const { projects, project, environment, containers, error } = data;
  const managedCount = containers.filter((c) => c.managed).length;

  return (
    <>
      <DashboardHeader {...data.user} />

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

            <section className="space-y-2">
              <div className="flex items-baseline justify-between">
                <h2 className="font-display text-text text-sm font-medium">
                  {t("containersHeading")}
                </h2>
                <p className="text-text-subtle text-xs">
                  {t("createdHere", {
                    managed: managedCount,
                    total: containers.length,
                  })}
                </p>
              </div>

              <Card>
                {containers.length === 0 ? (
                  <EmptyState
                    title={t("emptyTitle")}
                    description={t("emptyDescription")}
                  />
                ) : (
                  // Named so the list is distinguishable from other lists on the
                  // page — the toast viewport is also a list.
                  <ul aria-label={t("containersListLabel")}>
                    {containers.map((container) => (
                      <ContainerRow
                        key={container.serviceId}
                        container={container}
                        projectId={project?.id ?? ""}
                        environmentId={environment?.id ?? ""}
                      />
                    ))}
                  </ul>
                )}
              </Card>

              <p className="text-text-subtle text-xs">
                {/* Rich text, not concatenation: the <code> span has to be able to move
                    within the sentence when the sentence is translated. */}
                {t.rich("prefixNote", {
                  prefix: managedPrefix(),
                  code: (chunks) => <code className="font-mono">{chunks}</code>,
                })}
              </p>
            </section>
          </>
        )}
      </main>
    </>
  );
}
