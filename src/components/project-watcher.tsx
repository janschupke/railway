"use client";

import { useProjectWatcher } from "@/hooks/use-project-watcher";

/**
 * Renders nothing; holds the connection that keeps this tab in step with Railway.
 *
 * A component rather than a hook call inside the page, because the page is a Server
 * Component. Mounted beside the picker so a project switch remounts it, and absent
 * entirely when there is no project — there would be nothing to watch.
 */
export function ProjectWatcher({
  projectId,
  environmentId,
}: {
  projectId: string;
  environmentId: string;
}) {
  useProjectWatcher(projectId, environmentId);
  return null;
}
