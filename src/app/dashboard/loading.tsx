import { getTranslations } from "next-intl/server";
import {
  ContainerSectionSkeleton,
  ProjectPickerSkeleton,
  SpinUpFormSkeleton,
} from "@/components/dashboard-skeletons";
import { PageMain } from "@/components/ui/page";

/**
 * Cold navigation into the dashboard.
 *
 * Composed from the same pieces as the in-page fallback in page.tsx, so a loading row
 * is defined once. This boundary covers the whole route; the one inside page.tsx covers
 * only the container list, which is what a project switch replaces.
 *
 * There is no header placeholder because the header is no longer part of this route: it
 * renders in the root layout, above this boundary, and is never replaced when the page
 * resolves. That is what makes the bar provably still when the dashboard settles, rather
 * than a second copy of the markup that had to be kept pixel-identical by hand.
 */
export default async function DashboardLoading() {
  const t = await getTranslations();

  return (
    <PageMain aria-busy="true" aria-label={t("dashboard.loading")}>
      <ProjectPickerSkeleton />
      <SpinUpFormSkeleton />
      <ContainerSectionSkeleton heading={t("dashboard.containersHeading")} />
    </PageMain>
  );
}
