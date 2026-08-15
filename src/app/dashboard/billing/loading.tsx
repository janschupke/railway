import { getTranslations } from "next-intl/server";
import {
  BillingSectionSkeleton,
  ProjectPickerSkeleton,
} from "@/components/dashboard-skeletons";
import { PageMain } from "@/components/ui/page";

/**
 * Cold navigation into the billing tab.
 *
 * The same two pieces this route draws, in the same order. No header and no tab-strip
 * placeholder: both render above this boundary, in the root and dashboard layouts
 * respectively, and survive the transition.
 */
export default async function BillingLoading() {
  const t = await getTranslations("dashboard");

  return (
    <PageMain aria-busy="true" aria-label={t("loading")}>
      <ProjectPickerSkeleton />
      <BillingSectionSkeleton
        spendHeading={t("spendHeading")}
        usageHeading={t("usageHeading")}
      />
    </PageMain>
  );
}
