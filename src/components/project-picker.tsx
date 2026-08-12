"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import type { RailwayProject } from "@/lib/railway/types";
import { Select } from "./ui/select";

/**
 * Selection lives in the URL rather than component state, so the dashboard is
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

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Select
        label="Project"
        value={projectId ?? undefined}
        disabled={pending}
        options={projects.map((p) => ({ value: p.id, label: p.name }))}
        onValueChange={(id) => {
          const next = new URLSearchParams(params);
          next.set("project", id);
          // The old environment belongs to the old project; let the server default it.
          next.delete("environment");
          navigate(next);
        }}
      />

      <Select
        label="Environment"
        value={environmentId ?? undefined}
        disabled={pending || !selected}
        options={
          selected?.environments.map((e) => ({ value: e.id, label: e.name })) ?? []
        }
        onValueChange={(id) => {
          const next = new URLSearchParams(params);
          next.set("environment", id);
          navigate(next);
        }}
      />
    </div>
  );
}
