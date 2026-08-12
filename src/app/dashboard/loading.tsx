import { getTranslations } from "next-intl/server";
import {
  ContainerSectionSkeleton,
  DashboardHeaderSkeleton,
  ProjectPickerSkeleton,
  SpinUpFormSkeleton,
} from "@/components/dashboard-skeletons";

/**
 * Cold navigation into the dashboard.
 *
 * Composed from the same pieces as the in-page fallback in page.tsx, so a loading row
 * is defined once. This boundary covers the whole route; the one inside page.tsx covers
 * only the container list, which is what a project switch replaces.
 */
export default async function DashboardLoading() {
  const t = await getTranslations();

  return (
    <>
      <DashboardHeaderSkeleton appName={t("app.name")} />

      <main
        className="mx-auto w-full max-w-4xl flex-1 space-y-6 p-6"
        aria-busy="true"
        aria-label={t("dashboard.loading")}
      >
        <ProjectPickerSkeleton />
        <SpinUpFormSkeleton />
        <ContainerSectionSkeleton heading={t("dashboard.containersHeading")} />
      </main>
    </>
  );
}
