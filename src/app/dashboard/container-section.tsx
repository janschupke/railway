import { getTranslations } from "next-intl/server";
import { ContainerList } from "@/components/container-list";
import { ContainerSectionHeader } from "@/components/container-section-header";
import { Banner } from "@/components/ui/banner";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
import { Text } from "@/components/ui/text";
import { managedPrefix } from "@/lib/railway/managed";
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

  const { containers, error } = await loadContainers(projectId, environmentId);

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
    </section>
  );
}
