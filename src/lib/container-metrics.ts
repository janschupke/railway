import type { Container, ContainerMetrics } from "./railway/types";

/**
 * What the containers this app created are using, added up.
 *
 * Pure and React-free so it can be unit-tested in the node project, and so the one piece of
 * arithmetic the cost story rests on is not buried in a component. Sibling to
 * container-filters.ts for the same reason: the list's client-side reductions belong
 * together, and neither of them touches Railway.
 *
 * The default scope is the ticket's: only containers this app created, identified by the
 * same `managed` flag the owner filter and the destroy gate already key on. A total that
 * quietly included services someone else made would be the exact misreading the copy around
 * it is written to prevent.
 *
 * **`managedOnly: false` widens it, and the widening is only safe because it is labelled.**
 * The usage tooltip states two figures — what this app's containers use, and what everything
 * in the environment uses — and the second is what makes the first legible: a number with
 * nothing beside it is a number nobody can tell is large. The invariant above is not relaxed
 * by the option; it is that a total must never be shown without saying which set it covers,
 * and a caller that widens the scope owes the reader that sentence. Note the second figure
 * is still an *environment* total, never a workspace one — the only workspace figure in this
 * app is `spend`, in dollars, on the Billing tab.
 *
 * **The ceilings are deliberately not summed here, and this will be proposed again.** Each
 * row now reads "0.25 of 2 vCPU", and totalling the denominators to "6 vCPU provisioned"
 * fails twice. Railway bills measured usage, and this sentence renders inches from
 * `workspaceSpend` — the app's only monetary figure — where a provisioned total reads as
 * "you are paying for 6", which is false. And summing changes what the number is: per row a
 * ceiling is an enforced limit on one container, where a sum of ceilings is a capacity claim
 * with nothing to compare it against. A limit belongs beside the reading it bounds.
 */
export type MetricsTotals = {
  /** Null when nothing answered — see below on why that is not zero. */
  cpuCores: number | null;
  memoryGb: number | null;
  /** How many containers actually contributed, which is what the sentence counts. */
  containers: number;
};

export function sumContainerMetrics(
  containers: Container[],
  metrics: Record<string, ContainerMetrics>,
  options: { managedOnly?: boolean } = {},
): MetricsTotals {
  const { managedOnly = true } = options;

  let cpuCores: number | null = null;
  let memoryGb: number | null = null;
  let counted = 0;

  for (const container of containers) {
    if (managedOnly && !container.managed) continue;

    const usage = metrics[container.serviceId];
    if (!usage) continue;

    /*
     * Absent is not zero, and the accumulator starts at null to keep it that way.
     *
     * A project whose metrics were refused, or whose containers are all stopped, sums to
     * nothing — and "0.00 vCPU" would state that the infrastructure is running and idle,
     * which is a claim about someone's bill. Null renders as an em dash instead, which
     * states nothing. The first real sample is what promotes the accumulator off null.
     */
    if (usage.cpuCores !== null) cpuCores = (cpuCores ?? 0) + usage.cpuCores;
    if (usage.memoryGb !== null) memoryGb = (memoryGb ?? 0) + usage.memoryGb;

    // Counted on having an entry at all, not on either measurement: a container Railway
    // reported on is one the total covers, even if only one of the two values arrived.
    counted += 1;
  }

  return { cpuCores, memoryGb, containers: counted };
}
