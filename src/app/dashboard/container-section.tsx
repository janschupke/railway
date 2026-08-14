import { getLocale, getTranslations } from "next-intl/server";
import { ContainerList } from "@/components/container-list";
import { ContainerSectionHeader } from "@/components/container-section-header";
import { Banner } from "@/components/ui/banner";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
import { Text } from "@/components/ui/text";
import { LINKS } from "@/lib/constants";
import { managedPrefix } from "@/lib/railway/managed";
import type { WorkspaceSpend } from "@/lib/railway/types";
import { loadContainers } from "./data";

/**
 * The container list and everything derived from it.
 *
 * Split out of page.tsx so its Railway round trip sits behind a Suspense boundary
 * rather than in front of the shell. The prefix note needs containers, so the whole
 * section moves — including its heading, which the fallback then renders as real text so
 * it never flickers.
 *
 * This half is the part that does not depend on what the reader has filtered to: the
 * fetch, the failure banner, the "nothing here at all" state, and the prefix note.
 * Filtering, paging and the count sentence live in ContainerList, on the client, because
 * Railway's project query accepts no filter arguments — narrowing on the server would
 * mean a round trip per keystroke to compute an answer this app can compute locally.
 *
 * The containers-failed banner lives here rather than at the top of <main>: it explains
 * this section, not the page. A failed *project* list is the one that invalidates the
 * shell, and that banner stays where it was.
 */
export async function ContainerSection({
  projectId,
  environmentId,
}: {
  projectId: string | null;
  environmentId: string | null;
}) {
  const t = await getTranslations("dashboard");
  const locale = await getLocale();

  // A project with no environments has nothing to fetch; returning before the first
  // await keeps this off the suspending path entirely.
  if (!projectId || !environmentId) {
    return (
      <section className="space-y-2">
        <ContainerSectionHeader heading={t("containersHeading")} />
        <Card>
          <EmptyState title={t("emptyTitle")} description={t("emptyDescription")} />
        </Card>
      </section>
    );
  }

  const { containers, error, metrics, spend } = await loadContainers(
    projectId,
    environmentId,
  );

  /*
   * Two shapes, and only one of them can be filtered.
   *
   * An environment with nothing in it stays server-rendered: a filter bar above an empty
   * state offers controls that can only ever return the same nothing. Everything else
   * hands off to ContainerList, which owns the heading's count sentence too — it is the
   * only side that knows how much of the list is currently on screen.
   */
  return (
    <section className="space-y-2">
      {error && <Banner tone="error">{error}</Banner>}

      {containers.length === 0 ? (
        <>
          <ContainerSectionHeader heading={t("containersHeading")} />
          <Card>
            <EmptyState title={t("emptyTitle")} description={t("emptyDescription")} />
          </Card>
        </>
      ) : (
        <ContainerList
          containers={containers}
          projectId={projectId}
          environmentId={environmentId}
          heading={t("containersHeading")}
          metrics={metrics}
        />
      )}

      <Text asChild variant="caption" tone="subtle">
        <p>
          {/* Rich text, not concatenation: the <code> span has to be able to move
              within the sentence when the sentence is translated. */}
          {t.rich("prefixNote", {
            prefix: managedPrefix(),
            /* Only the family changes here: mono at its own token size next to sans copy
               would step down twice, since mono already reads smaller per em. */
            code: (chunks) => <code className="font-mono">{chunks}</code>,
          })}
        </p>
      </Text>

      {/*
        Directly under the prefix note, and that placement is the argument.

        That paragraph is already this section's statement of what this app owns and what it
        merely shows; the spend caveat is the same kind of claim about the same boundary. Put
        beside the list's own usage total instead, the two numbers would read as one — a
        workspace-wide dollar figure sitting next to a managed-only vCPU figure is exactly
        the misreading this ticket has to avoid.
      */}
      <WorkspaceSpendNote spend={spend} t={t} locale={locale} />
    </section>
  );
}

/**
 * What the workspace has spent this period, or where to find out.
 *
 * The figure is workspace-wide and the copy says so in the same sentence, because there is
 * no honest way to narrow it: `estimatedUsage` returns GB and vCPU rather than money, and the
 * only monetary fields in Railway's schema hang off `Customer`, which hangs off a workspace.
 * A number presented as "what your containers cost" would be wrong by however much else lives
 * in that workspace.
 *
 * The two absent branches render the same thing on purpose. A personal project has no
 * workspace, and a token without `workspace:viewer` cannot read one — from the reader's side
 * those are the same situation: the figure is not available here, it is over there. Neither
 * is an error and neither gets a banner, because an absent cost figure is not something the
 * reader can act on in this app. Offering a re-consent prompt for a read-only nicety is the
 * button-that-never-works pattern the empty-project state already argues against.
 */
function WorkspaceSpendNote({
  spend,
  t,
  locale,
}: {
  spend: WorkspaceSpend | null;
  /*
   * Handed down rather than fetched here, and the reason is mechanical: an async component
   * nested inside another one has no Suspense boundary of its own on this path, so it
   * renders as an unresolved promise everywhere except a full RSC runtime. The section is
   * already awaited and already holds both of these.
   */
  t: Awaited<ReturnType<typeof getTranslations<"dashboard">>>;
  locale: string;
}) {
  if (!spend) {
    return (
      <Text asChild variant="caption" tone="subtle">
        <p>
          {t("workspaceSpendUnavailable")}{" "}
          <a
            href={LINKS.RAILWAY_BILLING}
            target="_blank"
            rel="noreferrer"
            className="focus-ring link"
          >
            {t("openRailwayBilling")}
          </a>
        </p>
      </Text>
    );
  }

  /*
   * USD, hardcoded, and that is a stated limitation rather than an assumption nobody
   * noticed: `Customer.currentUsage` is a bare Float with no currency field anywhere beside
   * it, and Railway bills in dollars. Formatted through Intl rather than concatenated so the
   * symbol lands where the reader's locale puts it.
   */
  const amount = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
  }).format(spend.currentUsage);

  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });

  return (
    <Text asChild variant="caption" tone="subtle">
      <p>
        {t("workspaceSpend", {
          /*
           * A select rather than a placeholder with a fallback string. Substituting a
           * phrase into "The {workspace} workspace" produced "The this project's workspace
           * workspace" — the placeholder was doing two jobs, and a translator had no way to
           * see that. The whole sentence stays one message so its clauses can be reordered.
           */
          named: spend.workspaceName ? "yes" : "no",
          workspace: spend.workspaceName ?? "",
          amount,
          start: date.format(new Date(spend.periodStart)),
          end: date.format(new Date(spend.periodEnd)),
        })}
      </p>
    </Text>
  );
}
