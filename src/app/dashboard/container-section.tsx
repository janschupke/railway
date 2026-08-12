import { getTranslations } from "next-intl/server";
import { ContainerRow } from "@/components/container-row";
import { Banner } from "@/components/ui/banner";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
import { managedPrefix } from "@/lib/railway/managed";
import { loadContainers } from "./data";

/**
 * The container list and everything derived from it.
 *
 * Split out of page.tsx so its Railway round trip sits behind a Suspense boundary
 * rather than in front of the shell. The managed count and the prefix note both need
 * containers, so the whole section moves — including its heading, which the fallback
 * then renders as real text so it never flickers.
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
        <div className="flex items-baseline justify-between">
          <h2 className="font-display text-text text-sm font-medium">
            {t("containersHeading")}
          </h2>
        </div>
        <Card>
          <EmptyState title={t("emptyTitle")} description={t("emptyDescription")} />
        </Card>
      </section>
    );
  }

  const { containers, error } = await loadContainers(projectId, environmentId);
  const managedCount = containers.filter((c) => c.managed).length;

  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-text text-sm font-medium">
          {t("containersHeading")}
        </h2>
        <p className="text-text-subtle text-xs">
          {t("createdHere", { managed: managedCount, total: containers.length })}
        </p>
      </div>

      {error && <Banner tone="error">{error}</Banner>}

      <Card>
        {containers.length === 0 ? (
          <EmptyState title={t("emptyTitle")} description={t("emptyDescription")} />
        ) : (
          // Named so the list is distinguishable from other lists on the page — the
          // toast viewport is also a list.
          <ul aria-label={t("containersListLabel")}>
            {containers.map((container) => (
              <ContainerRow
                key={container.serviceId}
                container={container}
                projectId={projectId}
                environmentId={environmentId}
              />
            ))}
          </ul>
        )}
      </Card>

      <p className="text-text-subtle text-xs">
        {/* Rich text, not concatenation: the <code> span has to be able to move
            within the sentence when the sentence is translated. */}
        {t.rich("prefixNote", {
          prefix: managedPrefix(),
          code: (chunks) => <code className="font-mono">{chunks}</code>,
        })}
      </p>
    </section>
  );
}
