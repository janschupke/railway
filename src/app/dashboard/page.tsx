import { redirect } from "next/navigation";
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
              title="No projects shared with this app"
              description="Railway's consent screen controls which projects are visible here. Sign in again and select at least one project."
              action={
                <SignInButton label="Choose projects" variant="secondary" size="sm" />
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
                  Containers
                </h2>
                <p className="text-text-subtle text-xs">
                  {managedCount} of {containers.length} created here
                </p>
              </div>

              <Card>
                {containers.length === 0 ? (
                  <EmptyState
                    title="Nothing running in this environment"
                    description="Spin one up above and its build logs will stream here."
                  />
                ) : (
                  // Named so the list is distinguishable from other lists on the
                  // page — the toast viewport is also a list.
                  <ul aria-label="Containers">
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
                Services named <code className="font-mono">{managedPrefix()}…</code>{" "}
                were created here and can be destroyed here. Everything else is shown
                for context only.
              </p>
            </section>
          </>
        )}
      </main>
    </>
  );
}
