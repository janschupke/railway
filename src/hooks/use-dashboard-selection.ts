"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

/** Query-parameter names — protocol shared with the page's searchParams, not copy. */
const PARAM = { project: "project", environment: "environment" } as const;

/**
 * Writing the dashboard's selection, which lives in the URL and nowhere else.
 *
 * Extracted from ProjectPicker when the create dialogs arrived: three controls now change
 * the selection — the two selects and a create that lands the user on what it just made —
 * and each writing its own `router.push` is how the environment param stops being cleared
 * on one of the three paths. There is one place that knows the rules, and this is it.
 *
 * Every writer copies the *current* params rather than building fresh ones, so the
 * container list's own filters survive a project switch. They are client-side state kept
 * in the query string; dropping them here would silently reset the user's search.
 */
export function useDashboardSelection(): {
  selectProject: (projectId: string) => void;
  selectEnvironment: (environmentId: string) => void;
  /** After a create: land on the new project, and its environment when there is one. */
  select: (projectId: string, environmentId?: string) => void;
  pending: boolean;
} {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const navigate = (next: URLSearchParams) => {
    startTransition(() => router.push(`/dashboard?${next.toString()}`));
  };

  return {
    selectProject: (projectId) => {
      const next = new URLSearchParams(params);
      next.set(PARAM.project, projectId);
      // The old environment belongs to the old project; let the server default it.
      next.delete(PARAM.environment);
      navigate(next);
    },
    selectEnvironment: (environmentId) => {
      const next = new URLSearchParams(params);
      next.set(PARAM.environment, environmentId);
      navigate(next);
    },
    select: (projectId, environmentId) => {
      const next = new URLSearchParams(params);
      next.set(PARAM.project, projectId);
      /*
       * Deleted rather than left alone when the caller has no environment id. A project
       * created without one would otherwise inherit the previous project's environment in
       * the URL, which the server drops anyway — but silently, and one render later.
       */
      if (environmentId) next.set(PARAM.environment, environmentId);
      else next.delete(PARAM.environment);
      navigate(next);
    },
    pending,
  };
}
