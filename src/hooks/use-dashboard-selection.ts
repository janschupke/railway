"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

/** Query-parameter names — protocol shared with the page's searchParams, not copy. */
const PARAM = { project: "project", environment: "environment" } as const;

/** The tab a finished spin-up belongs on. A route, not copy. */
const CONTAINERS = "/dashboard";

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
  /** After a successful spin-up: the container it made is on the list tab, not this one. */
  goToContainers: () => void;
  pending: boolean;
} {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  /*
   * The current path, not a literal.
   *
   * This used to push `/dashboard` outright, which was correct while that was the only
   * route. It is now one of three, and changing project from the spin-up or billing tab
   * would have quietly moved the reader to the container list — a selection change is not
   * a navigation, and this is what says so.
   */
  const navigate = (next: URLSearchParams) => {
    startTransition(() => router.push(`${pathname}?${next.toString()}`));
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
    /*
     * The one writer that names a route, and it earns it: this is a hop to a different
     * view rather than a change of what the current one is showing. The spin-up form
     * calls it once its create has succeeded, because the row it just made — and the
     * build logs streaming into it — are on the container tab.
     *
     * The params are copied like every other writer's, so the selection travels and the
     * list's filters survive.
     */
    goToContainers: () => {
      const next = new URLSearchParams(params);
      startTransition(() => router.push(`${CONTAINERS}?${next.toString()}`));
    },
    pending,
  };
}
