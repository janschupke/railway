"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { useTranslations } from "next-intl";
import type { RailwayProject } from "@/lib/railway/types";
import { PendingStatus } from "./ui/misc";
import { Select } from "./ui/select";

/** Query-parameter names — protocol shared with the page's searchParams, not copy. */
const PARAM = { project: "project", environment: "environment" } as const;

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
  const t = useTranslations("dashboard");
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const selected = projects.find((p) => p.id === projectId);

  const navigate = (next: URLSearchParams) => {
    startTransition(() => router.push(`/dashboard?${next.toString()}`));
  };

  return (
    /*
     * The selects stay enabled while the route transition runs. Disabling the control
     * the user just committed removes it from the a11y tree and drops focus to <body>;
     * aria-busy says the same thing without stealing focus, and React supersedes the
     * earlier navigation if they change their mind mid-flight.
     */
    <div className="flex flex-wrap items-center gap-3" aria-busy={pending || undefined}>
      <Select
        label={t("projectLabel")}
        value={projectId ?? undefined}
        options={projects.map((p) => ({
          value: p.id,
          label: p.name,
          // Only projects reached through a workspace carry one, so an account whose
          // projects are all personal gets an ungrouped list exactly as before.
          ...(p.workspaceName ? { group: p.workspaceName } : {}),
        }))}
        onValueChange={(id) => {
          const next = new URLSearchParams(params);
          next.set(PARAM.project, id);
          // The old environment belongs to the old project; let the server default it.
          next.delete(PARAM.environment);
          navigate(next);
        }}
      />

      <Select
        label={t("environmentLabel")}
        value={environmentId ?? undefined}
        disabled={!selected}
        options={
          selected?.environments.map((e) => ({ value: e.id, label: e.name })) ?? []
        }
        onValueChange={(id) => {
          const next = new URLSearchParams(params);
          next.set(PARAM.environment, id);
          navigate(next);
        }}
      />

      <PendingStatus label={pending ? t("switchingProject") : undefined} />
    </div>
  );
}
