import { getLocale, getTranslations } from "next-intl/server";
import { SpendCard, UsageCard } from "@/components/billing-summary";
import { Banner } from "@/components/ui/banner";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/misc";
import { LINKS } from "@/lib/constants";
import { sumContainerMetrics } from "@/lib/container-metrics";
import { formatMemoryGb, formatVcpu } from "@/lib/format";
import { loadContainers } from "./data-containers";

/**
 * What the workspace has spent, and what this app's own containers are using.
 *
 * The spend half was one sentence at the foot of the container list; the ticket asked for a
 * readout instead, and putting it beside the usage total is the part that needed care.
 * container-section.tsx used to carry the argument for keeping them apart — a workspace-wide
 * dollar figure next to a managed-only vCPU figure reads as one number explaining the other —
 * and that argument has not gone away, it has been answered differently: two cards, each
 * headed with its own scope and carrying its own scope sentence. See billing-summary.tsx.
 *
 * Reads through the *same* memoised `loadContainers` the container tab uses. On this route it
 * is the only caller, so it pays for the whole loader — the volume read included, which
 * nothing here renders. That is one Railway round trip for a tab, which is what the other two
 * cost as well.
 */
export async function BillingSection({
  projectId,
  environmentId,
}: {
  projectId: string | null;
  environmentId: string | null;
}) {
  const t = await getTranslations("dashboard");
  const tContainers = await getTranslations("containers");
  const tCommon = await getTranslations("common");
  const locale = await getLocale();

  /*
   * Nothing to scope a figure to. Returning before the first await keeps this off the
   * suspending path entirely, exactly as ContainerSection does.
   *
   * Its own copy rather than the container list's `emptyTitle`/`emptyDescription`, which
   * promise build logs — there are none on this tab, and reusing a string because two
   * surfaces happen to be empty at the same time is how copy stops describing what it is
   * under.
   */
  if (!projectId || !environmentId) {
    return (
      <Card>
        <EmptyState
          title={t("billingNoSelectionTitle")}
          description={t("billingNoSelectionDescription")}
        />
      </Card>
    );
  }

  const { containers, error, metrics, spend } = await loadContainers(
    projectId,
    environmentId,
  );

  /*
   * USD, hardcoded, and that is a stated limitation rather than an assumption nobody
   * noticed: `Customer.currentUsage` is a bare Float with no currency field anywhere beside
   * it, and Railway bills in dollars. Formatted through Intl rather than concatenated so the
   * symbol lands where the reader's locale puts it.
   */
  const amount = spend
    ? new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(
        spend.currentUsage,
      )
    : null;

  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  const period = spend
    ? t("spendPeriodValue", {
        start: date.format(new Date(spend.periodStart)),
        end: date.format(new Date(spend.periodEnd)),
      })
    : "";

  /*
   * Over every container in the environment, unlike container-list.tsx, which sums the
   * *filtered* set so its total describes the rows on screen. There are no filters here, so
   * the honest scope is the whole environment — and the card's own sentence says so.
   */
  const totals = sumContainerMetrics(containers, metrics);
  const cpu = formatVcpu(totals.cpuCores, locale);
  const memory = formatMemoryGb(totals.memoryGb, locale);

  return (
    <section className="space-y-3">
      {/* Same placement argument the container list's banner makes: this explains the
          section, not the page. A failed *project* read is the one that invalidates the
          shell, and that banner is in DashboardFrame. */}
      {error && <Banner tone="error">{error}</Banner>}

      <SpendCard
        heading={t("spendHeading")}
        amount={amount}
        amountLabel={t("spendAmountLabel")}
        periodLabel={t("spendPeriodLabel")}
        period={period}
        workspaceLabel={t("spendWorkspaceLabel")}
        /*
         * A named workspace or the generic phrase, chosen here rather than by an ICU
         * `select` inside one sentence. That wrapper existed because the whole thing used to
         * be one paragraph — "The {workspace} workspace has used…" — where a placeholder
         * carrying a fallback phrase produced "The this project's workspace workspace". A
         * labelled cell has no sentence to fit into, so the branch is a plain choice again.
         */
        workspace={spend?.workspaceName ?? t("spendWorkspaceUnnamed")}
        caveat={t("spendCaveat")}
        unavailable={t("workspaceSpendUnavailable")}
        billingHref={LINKS.RAILWAY_BILLING}
        billingLabel={t("openRailwayBilling")}
      />

      <UsageCard
        heading={t("usageHeading")}
        cpu={
          cpu
            ? tContainers("cpuValue", {
                /*
                 * A summed trace is still a trace: twenty containers each below a hundredth
                 * of a core add up to something the two-decimal format still cannot show,
                 * and "0.00 vCPU" is a claim about idle infrastructure someone is paying
                 * for.
                 */
                value: cpu.trace
                  ? tCommon("lessThan", { value: cpu.value })
                  : cpu.value,
              })
            : null
        }
        cpuLabel={t("usageCpuLabel")}
        memory={
          memory
            ? memory.unit === "gb"
              ? tContainers("memoryValueGb", { value: memory.value })
              : tContainers("memoryValueMb", { value: memory.value })
            : null
        }
        memoryLabel={t("usageMemoryLabel")}
        containers={new Intl.NumberFormat(locale).format(totals.containers)}
        containersLabel={t("usageContainersLabel")}
        scope={t("usageScope")}
        none={t("usageNone")}
      />
    </section>
  );
}
