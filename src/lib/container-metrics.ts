import type { Container, ContainerMetrics } from "./railway/types";

/**
 * What the containers this app created are using, added up.
 *
 * Pure and React-free so it can be unit-tested in the node project, and so the one piece of
 * arithmetic the cost story rests on is not buried in a component. Sibling to
 * container-filters.ts for the same reason: the list's client-side reductions belong
 * together, and neither of them touches Railway.
 *
 * The scope is the ticket's: only containers this app created, identified by the same
 * `managed` flag the owner filter and the destroy gate already key on. A total that quietly
 * included services someone else made would be the exact misreading the copy around it is
 * written to prevent.
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
): MetricsTotals {
  let cpuCores: number | null = null;
  let memoryGb: number | null = null;
  let counted = 0;

  for (const container of containers) {
    if (!container.managed) continue;

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
