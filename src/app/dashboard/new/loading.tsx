import { getTranslations } from "next-intl/server";
import {
  ProjectPickerSkeleton,
  SpinUpFormSkeleton,
} from "@/components/dashboard-skeletons";
import { PageMain } from "@/components/ui/page";

/**
 * Cold navigation into the provisioning tab.
 *
 * The same two pieces this route actually draws, in the same order, so nothing shifts when
 * the shell resolves. No header and no tab-strip placeholder: both render above this
 * boundary, in the root and dashboard layouts respectively, and survive the transition.
 */
export default async function NewContainerLoading() {
  const t = await getTranslations();

  return (
    <PageMain aria-busy="true" aria-label={t("dashboard.loading")}>
      <ProjectPickerSkeleton />
      <SpinUpFormSkeleton />
    </PageMain>
  );
}
