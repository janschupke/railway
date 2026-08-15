import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ContainerList } from "@/components/container-list";
import { ContainerSectionHeader } from "@/components/container-section-header";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
import { Text } from "@/components/ui/text";
import { managedPrefix } from "@/lib/railway/managed";
import { loadContainers } from "./data-containers";

/** The provisioning tab an empty environment sends people to. A route, not copy. */
const NEW_CONTAINER = "/dashboard/new";

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

  // A project with no environments has nothing to fetch; returning before the first
  // await keeps this off the suspending path entirely.
  if (!projectId || !environmentId) {
    return (
      <section className="space-y-2">
        <ContainerSectionHeader heading={t("containersHeading")} />
        <Card>
          {/*
            No create CTA on this branch, unlike the empty-environment one below, and the
            asymmetry is deliberate: there is no environment to spin a container up into,
            so the form on the other tab would render disabled. A button that leads to a
            dead control is the pattern the no-projects state already argues against.
          */}
          <EmptyState title={t("emptyTitle")} description={t("emptyDescription")} />
        </Card>
      </section>
    );
  }

  const { containers, error, metrics, volumes } = await loadContainers(
    projectId,
    environmentId,
  );

  /*
   * The selection travels; the list's own filters do not.
   *
   * Built here rather than in the client, because this branch has the two resolved ids
   * already and nothing on it is interactive. Dropping q/status/owner is correct: a link
   * out of an empty list has no filters worth carrying, and the server cannot see them
   * anyway — see the searchParams note in page.tsx.
   */
  const newContainerHref = `${NEW_CONTAINER}?${new URLSearchParams({
    project: projectId,
    environment: environmentId,
  }).toString()}`;

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
            <EmptyState
              title={t("emptyTitle")}
              description={t("emptyDescription")}
              /*
                The form used to sit directly above this card, so "spin one up above" was
                both the instruction and the pointer. It is a tab away now, and an empty
                state that only describes the absence leaves the reader to find the way
                out — so the way out is the card's own centred action. EmptyState centres
                its `action` slot already.
              */
              action={
                <Button asChild variant="primary" size="sm">
                  <Link href={newContainerHref}>{t("emptyCta")}</Link>
                </Button>
              }
            />
          </Card>
        </>
      ) : (
        <ContainerList
          containers={containers}
          projectId={projectId}
          environmentId={environmentId}
          heading={t("containersHeading")}
          metrics={metrics}
          volumes={volumes}
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
        The spend caveat used to sit directly under the prefix note, and the argument for
        that placement was the one this comment replaces: the two paragraphs make the same
        kind of claim about the same boundary — what this app owns versus what it merely
        shows — and putting a workspace-wide dollar figure beside the list's managed-only
        vCPU total would have made the two numbers read as one.

        The figure has its own tab now, which is the same separation by other means. It is
        NOT that the objection was dropped: /dashboard/billing renders the two as separate
        cards, each headed with its own scope and carrying its own scope sentence, and
        billing-summary.tsx is where that is written down. If those ever merge into one
        panel of four figures, this paragraph is the argument against it.
      */}
    </section>
  );
}
