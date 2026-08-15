import type { ActionResult } from "@/lib/action-result";
import type { Retainable } from "@/lib/idempotency";
import type { createContainer } from "@/lib/railway/service-create";
import type { getTranslations } from "next-intl/server";

/** Exactly what `createContainer` resolved to, so the branches cannot drift from the union. */
type Created = Awaited<ReturnType<typeof createContainer>>;

/**
 * The translator `getTranslations()` returns with no namespace, which accepts full paths.
 *
 * Not `Translator` from ./action-form: `ReturnType` resolves to next-intl's *namespaced*
 * overload, whose keys are relative to a namespace, so `t("actions.spinningUp")` does not
 * typecheck against it. `action-destroy.ts` records that trap in prose; this is what naming
 * the type it warns about looks like.
 */
type RootTranslator = Awaited<ReturnType<typeof getTranslations<never>>>;

/**
 * What the user is told, given what `createContainer` managed to do.
 *
 * Pure, and that is the whole reason it is here rather than at the bottom of `attempt`. Six
 * outcomes and two independent facts about a successful one produce eleven sentences, and
 * every one of them was reachable only by driving the real thing through MSW — a large part
 * of `action-spin-up.integration.test.ts` exists to make Railway refuse a volume, or refuse
 * a deploy, purely to see which sentence came out.
 *
 * **`retain: true` on every path, including the failures, and that is not an oversight.** A
 * service exists on Railway by the time any of this runs, so a replay of the same submission
 * must be told about that one rather than make a second — see `runOnce`. Only a throw from
 * `createContainer` means nothing was created, and a throw never reaches here.
 */
export function spinUpOutcome(
  created: Created,
  name: string,
  generated: boolean,
  t: RootTranslator,
): Retainable<ActionResult> {
  /*
   * Every failure names the container. The service exists and is destroyable; saying only
   * "failed" would leave the user hunting for something they were not told had been
   * created — and on the deploy branch it is a billable orphan they would have no name
   * to search Railway for. The sentences differ because the remedies differ: refused
   * variables are a preset problem, a refused deploy is Railway's.
   *
   * Retained, all of them, and that is the point of saying so per-branch rather than
   * once at the end: a service exists, so a repeat of this submission must be told about
   * that one rather than make a second.
   */
  if (created.outcome === "volume_failed") {
    /*
     * The one branch where NOT deploying is the feature rather than damage control. This
     * image keeps state, Railway refused the volume, and a container that came up here would
     * take the user's data and lose it — which is the defect T-491 exists to remove. The
     * sentence says the container exists and is not running, because both halves are what
     * the person has to act on.
     */
    return {
      value: { ok: false, error: t("actions.createdButNoVolume", { name }) },
      retain: true,
    };
  }
  if (created.outcome === "settings_failed") {
    return {
      value: { ok: false, error: t("actions.createdButNoSettings", { name }) },
      retain: true,
    };
  }
  if (created.outcome === "limits_failed") {
    /*
     * Its own sentence rather than a share of the one above, because the likely cause is
     * different and so is the remedy: this is usually the plan behind the token refusing a
     * service that size, which is fixed by asking for less rather than by asking again.
     * Said as "usually" — the app cannot read the plan, and asserting a cause it cannot
     * check would be the same mistake as rendering upstream failure text.
     */
    return {
      value: { ok: false, error: t("actions.createdButNoLimits", { name }) },
      retain: true,
    };
  }
  if (created.outcome === "variables_failed") {
    return {
      value: { ok: false, error: t("actions.createdButNotConfigured", { name }) },
      retain: true,
    };
  }
  if (created.outcome === "deploy_failed") {
    return {
      value: { ok: false, error: t("actions.createdButNotDeployed", { name }) },
      retain: true,
    };
  }

  /*
   * Four whole sentences over two independent facts, rather than one sentence with pieces
   * bolted on.
   *
   * The two are genuinely independent — a postgres mints a credential and gets no address,
   * an nginx gets an address and mints nothing, a rabbitmq does both — so something has to
   * carry the combinations. Composing them from fragments at runtime is the version that
   * cannot be translated: word order, and whether the second clause is even a separate
   * sentence, are decisions the catalog has to be allowed to make per language. See
   * .ai/rules/i18n.md.
   *
   * `generated` is gated on what was MINTED rather than on whether any variable was set: a
   * user who typed their own password has their own copy, and sending them to Railway to
   * read it back would be telling them to look up something they already know.
   *
   * `created.url` may be null on a spin-up that asked for a domain — Railway refused it, and
   * `railway.domain_failed` has the record. The user is told about the container rather than
   * about the missing address, because the container is what they asked for and the row now
   * offers the control that fixes the rest.
   */
  const url = created.url;
  return {
    value: {
      ok: true,
      message: url
        ? generated
          ? t("actions.spinningUpWithCredentialsAtUrl", { name, url })
          : t("actions.spinningUpAtUrl", { name, url })
        : generated
          ? t("actions.spinningUpWithCredentials", { name })
          : t("actions.spinningUp", { name }),
    },
    retain: true,
  };
}
