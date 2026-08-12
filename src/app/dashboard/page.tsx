import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/server";
import { getProjectContainers, listProjects } from "@/lib/railway/api";
import { RailwayApiError } from "@/lib/railway/errors";
import { managedPrefix } from "@/lib/railway/managed";
import type { Container, RailwayProject } from "@/lib/railway/types";
import { ContainerRow } from "@/components/container-row";
import { ProjectPicker } from "@/components/project-picker";
import { SpinUpForm } from "@/components/spin-up-form";
import { Banner, Button, Card } from "@/components/ui";

// The dashboard is a live view of Railway; caching it would show stale containers.
export const dynamic = "force-dynamic";

function Header({ name, email }: { name?: string; email?: string }) {
  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-4 px-6 py-3">
        <span className="font-semibold tracking-tight">Container Console</span>
        <div className="flex items-center gap-3">
          <span className="hidden text-sm text-muted sm:inline">
            {name ?? email ?? "Signed in"}
          </span>
          <form action="/api/auth/logout" method="post">
            <Button type="submit" variant="ghost">
              Sign out
            </Button>
          </form>
        </div>
      </div>
    </header>
  );
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; environment?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/");

  const { project: projectParam, environment: environmentParam } =
    await searchParams;

  let projects: RailwayProject[] = [];
  let loadError: string | null = null;

  try {
    ({ projects } = await listProjects(session.accessToken));
  } catch (error) {
    loadError =
      error instanceof RailwayApiError
        ? error.userMessage()
        : "Could not load your Railway projects.";
  }

  const selectedProject =
    projects.find((p) => p.id === projectParam) ?? projects[0] ?? null;
  const selectedEnvironment =
    selectedProject?.environments.find((e) => e.id === environmentParam) ??
    selectedProject?.environments[0] ??
    null;

  let containers: Container[] = [];
  if (!loadError && selectedProject && selectedEnvironment) {
    try {
      ({ containers } = await getProjectContainers(
        session.accessToken,
        selectedProject.id,
        selectedEnvironment.id,
      ));
    } catch (error) {
      loadError =
        error instanceof RailwayApiError
          ? error.userMessage()
          : "Could not load containers for this environment.";
    }
  }

  const managedCount = containers.filter((c) => c.managed).length;

  return (
    <>
      <Header name={session.user.name} email={session.user.email} />

      <main className="mx-auto w-full max-w-4xl flex-1 space-y-6 p-6">
        {loadError && <Banner tone="error">{loadError}</Banner>}

        {projects.length === 0 && !loadError ? (
          <Card className="space-y-2 p-6 text-center">
            <p className="font-medium">No projects shared with this app</p>
            <p className="text-sm text-muted">
              Railway&rsquo;s consent screen controls which projects are visible here.
              Sign in again and select at least one project.
            </p>
            <a
              href="/api/auth/login"
              className="focus-ring mt-2 inline-block rounded-md border border-border px-3 py-1.5 text-sm hover:bg-subtle"
            >
              Choose projects
            </a>
          </Card>
        ) : (
          <>
            <ProjectPicker
              projects={projects}
              projectId={selectedProject?.id ?? null}
              environmentId={selectedEnvironment?.id ?? null}
            />

            <SpinUpForm
              projectId={selectedProject?.id ?? ""}
              environmentId={selectedEnvironment?.id ?? ""}
              disabled={!selectedProject || !selectedEnvironment}
            />

            <section className="space-y-2">
              <div className="flex items-baseline justify-between">
                <h2 className="text-sm font-medium">Containers</h2>
                <p className="text-xs text-muted">
                  {managedCount} of {containers.length} created here
                </p>
              </div>

              <Card>
                {containers.length === 0 ? (
                  <p className="p-6 text-center text-sm text-muted">
                    Nothing running in this environment yet. Spin one up above.
                  </p>
                ) : (
                  <ul>
                    {containers.map((container) => (
                      <ContainerRow
                        key={container.serviceId}
                        container={container}
                        projectId={selectedProject!.id}
                        environmentId={selectedEnvironment!.id}
                      />
                    ))}
                  </ul>
                )}
              </Card>

              <p className="text-xs text-muted">
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
