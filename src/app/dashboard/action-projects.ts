import "server-only";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { requireAccessToken } from "@/lib/auth/server";
import type { ActionResult } from "@/lib/action-result";
import {
  /*
   * Aliased because the exported actions are the same two verbs. The repo's other actions
   * dodge this by being named for the UI rather than the API — spinUp calls
   * createContainer — and there is no such second name for "create a project" that is not
   * a euphemism.
   */
  createEnvironment as createEnvironmentOnRailway,
  createProject as createProjectOnRailway,
} from "@/lib/railway/api";
import { log } from "@/lib/logger";
import { environmentCreateSchema, projectCreateSchema } from "@/lib/validation";
import { formField, issueToResult, toActionError } from "./action-form";

/**
 * Creating a project and creating an environment.
 *
 * The two write paths with no ownership check and no container in them, which is why they
 * sit apart from the rest: nothing here can act on infrastructure this app did not create,
 * because both calls only ever add. Neither has a delete counterpart and neither ever will
 * — see docs/limitations.md on why the blast radius of deleting a project is its contents.
 */

export async function addProject(formData: FormData): Promise<ActionResult> {
  const t = await getTranslations();

  const parsed = projectCreateSchema.safeParse({
    name: formField(formData, "projectName"),
    workspaceId: formField(formData, "workspaceId"),
  });
  if (!parsed.success) {
    /*
     * Only `name` is renamed, because only `name` is on screen as a field the user typed
     * into. `workspaceId` is a select this app drew from a list Railway gave it, so it is
     * not an ActionField and its message falls through to a toast — the same treatment
     * `projectId` gets one function down, and for the same reason.
     */
    return issueToResult(t, parsed.error, { rename: { name: "projectName" } });
  }

  const { name, workspaceId } = parsed.data;

  try {
    const accessToken = await requireAccessToken();
    const project = await createProjectOnRailway(accessToken, name, workspaceId);

    /*
     * The audit trail, for the same reason `container.created` has one: this creates
     * billable infrastructure under someone's account. The name is user-supplied and
     * bounded at LIMITS.PROJECT_NAME_MAX, and it is the only field that makes the record
     * findable in Railway's own dashboard afterwards.
     *
     * There is no `project.destroyed` counterpart and there never will be — this app does
     * not delete projects, which is why they carry no MANAGED_PREFIX either.
     *
     * `workspace_id` is null for the personal account rather than absent, and flat like
     * every field beside it. A conditionally spread member would make "this went to the
     * personal account" and "somebody forgot to log where it went" the same line, and this
     * is the only record of where a project ended up — the app cannot move it afterwards.
     */
    log.info("project.created", {
      project_id: project.id,
      project_name: name,
      environment_count: project.environments.length,
      workspace_id: workspaceId ?? null,
    });

    revalidatePath("/dashboard");

    /*
     * Railway creates a default environment with the project, and the create mutation
     * returns it — so the ordinary path selects both. The fallback is a project with no
     * environment at all, which the picker already has a sentence for ("This project has
     * no environments"); naming an environment id that does not exist would be worse than
     * saying nothing.
     */
    const environment = project.environments[0];
    return {
      ok: true,
      message: t("actions.projectCreated", { name: project.name }),
      select: {
        projectId: project.id,
        ...(environment ? { environmentId: environment.id } : {}),
      },
    };
  } catch (error) {
    return toActionError(t, error);
  }
}

export async function addEnvironment(formData: FormData): Promise<ActionResult> {
  const t = await getTranslations();

  const parsed = environmentCreateSchema.safeParse({
    projectId: formField(formData, "projectId"),
    name: formField(formData, "environmentName"),
  });
  if (!parsed.success) {
    /*
     * Attributed to the only field on screen. A bad `projectId` is not something the form
     * can show — it is a hidden input the picker filled in — so its message reaches the
     * user as a toast instead, which is what an absent `field` means. `projectId` is not an
     * ActionField, so it falls through to exactly that.
     */
    return issueToResult(t, parsed.error, { rename: { name: "environmentName" } });
  }

  const { projectId, name } = parsed.data;

  try {
    const accessToken = await requireAccessToken();
    const environment = await createEnvironmentOnRailway(accessToken, projectId, name);

    log.info("environment.created", {
      project_id: projectId,
      environment_id: environment.id,
      environment_name: name,
    });

    revalidatePath("/dashboard");

    return {
      ok: true,
      message: t("actions.environmentCreated", { name: environment.name }),
      select: { projectId, environmentId: environment.id },
    };
  } catch (error) {
    return toActionError(t, error);
  }
}
