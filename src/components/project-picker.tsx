"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import type { RailwayProject } from "@/lib/railway/types";
import { cn } from "@/lib/utils";

/**
 * Selection lives in the URL rather than component state so the dashboard is
 * linkable, survives a refresh, and lets the server do the fetching.
 */
export function ProjectPicker({
  projects,
  projectId,
  environmentId,
}: {
  projects: RailwayProject[];
  projectId: string | null;
  environmentId: string | null;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const selected = projects.find((p) => p.id === projectId);

  const navigate = (next: URLSearchParams) => {
    startTransition(() => router.push(`/dashboard?${next.toString()}`));
  };

  const onProjectChange = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("project", id);
    // The old environment belongs to the old project; let the server pick the default.
    next.delete("environment");
    navigate(next);
  };

  const onEnvironmentChange = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("environment", id);
    navigate(next);
  };

  const selectClass = cn(
    "focus-ring rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm",
    pending && "opacity-60",
  );

  return (
    <div className="flex flex-wrap items-center gap-3">
      <label className="flex items-center gap-2 text-sm">
        <span className="text-muted">Project</span>
        <select
          className={selectClass}
          value={projectId ?? ""}
          disabled={pending}
          onChange={(e) => onProjectChange(e.target.value)}
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-2 text-sm">
        <span className="text-muted">Environment</span>
        <select
          className={selectClass}
          value={environmentId ?? ""}
          disabled={pending || !selected}
          onChange={(e) => onEnvironmentChange(e.target.value)}
        >
          {selected?.environments.map((environment) => (
            <option key={environment.id} value={environment.id}>
              {environment.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
