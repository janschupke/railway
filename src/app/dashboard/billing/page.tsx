import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { BillingSectionSkeleton } from "@/components/dashboard-skeletons";
import { BillingSection } from "../billing-section";
import { DashboardFrame } from "../dashboard-frame";
import { loadDashboardShell } from "../data-shell";

/**
 * What the workspace has spent, and what this app's containers are using — the billing tab.
 *
 * `dynamic = "force-dynamic"` is declared on the shared layout, not here.
 */
export default async function BillingPage({
  searchParams,
}: {
  /** Same two keys as the other tabs, for the reason page.tsx gives. */
  searchParams: Promise<{ project?: string; environment?: string }>;
}) {
  const { project: projectParam, environment: environmentParam } = await searchParams;

  const shell = await loadDashboardShell(projectParam, environmentParam);
  if (!shell) redirect("/");

  const t = await getTranslations("dashboard");
  const { project, environment } = shell;

  return (
    <DashboardFrame shell={shell}>
      {/*
        Keyed on the selection, for the reason spelled out in full on the container tab's
        boundary in ../page.tsx: React only reveals a fallback for a boundary it is mounting
        fresh, so without the key a project switch holds the previous project's figures on
        screen for the whole Railway round trip. The key must be on <Suspense> itself —
        keying the child remounts it under the same fiber, which looks identical in review
        and does not work.
      */}
      <Suspense
        key={`${project?.id ?? ""}:${environment?.id ?? ""}`}
        fallback={
          <BillingSectionSkeleton
            spendHeading={t("spendHeading")}
            usageHeading={t("usageHeading")}
          />
        }
      >
        <BillingSection
          projectId={project?.id ?? null}
          environmentId={environment?.id ?? null}
        />
      </Suspense>
    </DashboardFrame>
  );
}
