"use client";

import { useLocale, useTranslations } from "next-intl";
import { formatUptime, formatVcpu, formatVcpuLimit } from "@/lib/format";
import { useMemoryGb, useVolumeSize } from "@/hooks/use-memory-figure";
import type { ContainerMetrics, ContainerVolume } from "@/lib/railway/types";
import type { ContainerState } from "@/lib/railway/types";
import { Text } from "./ui/text";

/**
 * What one container is using, above its log pane.
 *
 * Up to four readouts in a wrapping row rather than a column beside the pane — two always,
 * uptime while it is running, and the volume when the container has one. The pane is a fixed
 * 256px and arrives lazily behind a skeleton, so a side-by-side layout would reflow when its
 * chunk lands — a layout shift on a page Lighthouse gates at 0.1 — and would need a
 * breakpoint, which the app reaches for four times in all of src/ and otherwise adapts by
 * wrapping
 * everywhere else. Above the pane it is one line at desktop width, two on a phone, and it
 * gives the panel something to show in its first frame.
 *
 * CPU and memory read as a fraction — "0.25 of 2 vCPU" — because the ceiling is the number
 * the user typed into the spin-up form and never saw again, and an absolute figure with
 * nothing to compare it against cannot answer the only question the panel is asked: is this
 * container near its limit. Railway enforces the ceiling and reports it in the same response
 * as the usage, so it costs no extra request. The totals sentence under the list deliberately
 * does NOT sum it — see lib/container-metrics.ts.
 *
 * Deliberately NOT a live region, and this is the decision most likely to be "fixed" by the
 * next person. The panel already holds role="log" with its implicit aria-live, and both
 * ui/live-region.tsx and ui/misc.tsx record what a third announcing source did to status
 * assertions here. A CPU figure that moves every couple of minutes is not worth interrupting
 * someone reading log output for. It is a labelled <dl> that updates silently.
 *
 * There is no loading state and no skeleton either, for a reason that is easy to miss:
 * metrics arrive in the same RSC payload as the row, so there is no client fetch and no
 * window to fill. `undefined` means Railway said nothing about this container — refused,
 * stopped, or too new to have a sample — and never "still on its way". A shimmer here would
 * be permanent on every stopped container.
 */
export function ContainerMetricsReadout({
  metrics,
  volume,
  state,
  deployedAt,
  name,
}: {
  metrics: ContainerMetrics | undefined;
  /** Undefined for a container with no volume, which is most of them. */
  volume: ContainerVolume | undefined;
  state: ContainerState;
  deployedAt: string | null;
  name: string;
}) {
  const t = useTranslations("containers");
  const tCommon = useTranslations("common");
  const locale = useLocale();

  const cpu = formatVcpu(metrics?.cpuCores ?? null, locale);
  const cpuLimit = formatVcpuLimit(metrics?.cpuLimitCores ?? null, locale);

  // Shared with the destroy dialog, which renders the same volume's size in its checkbox.
  const sized = useVolumeSize();
  const inMemory = useMemoryGb();

  /*
   * A ceiling renders only beside a reading, in both readouts.
   *
   * "— of 2 vCPU" would say what the container COULD use while saying nothing about whether
   * it is running, and it would weaken the em dash, which means one specific thing here:
   * Railway reported nothing. The limit series is constant and outlives the usage one — a
   * stopped container can answer with a ceiling and no sample — so this pair genuinely
   * occurs rather than being a case guarded against on principle.
   *
   * The trace marker is composed here rather than inside formatVcpu for the reason every
   * unit in this file is: "<" is copy.
   */
  const cpuText =
    cpu === null
      ? tCommon("noValue")
      : (() => {
          const value = cpu.trace
            ? tCommon("lessThan", { value: cpu.value })
            : cpu.value;
          return cpuLimit === null
            ? t("cpuValue", { value })
            : t("cpuValueOf", { value, limit: cpuLimit });
        })();

  const memoryText =
    metrics?.memoryGb == null
      ? tCommon("noValue")
      : metrics.memoryLimitGb == null
        ? inMemory(metrics.memoryGb)
        : t("memoryOf", {
            used: inMemory(metrics.memoryGb),
            limit: inMemory(metrics.memoryLimitGb),
          });

  /*
   * Uptime is shown for a running container and nothing else. A failed or removed one has a
   * deployedAt too, and rendering "up 3d 4h" beside a crashed badge would be the row
   * contradicting itself. Absent rather than em-dashed: a pair that cannot apply is better
   * left out than shown empty.
   */
  const uptime = state === "running" ? formatUptime(deployedAt, locale) : null;

  return (
    <dl
      aria-label={t("metricsLabel", { name })}
      className="flex flex-wrap items-baseline gap-x-6 gap-y-1"
    >
      <Readout label={t("cpuLabel")}>{cpuText}</Readout>

      <Readout label={t("memoryLabel")}>{memoryText}</Readout>

      {uptime !== null && <Readout label={t("uptimeLabel")}>{uptime}</Readout>}

      {/*
        Absent rather than em-dashed when there is no volume, on the same argument uptime
        makes above: most containers here keep nothing, and a permanent "Volume —" on every
        nginx row would read as a readout that is broken rather than one that does not apply.

        It is also the honest rendering of a refused EnvironmentVolumes read, where the app
        genuinely does not know — and the destroy dialog degrades the same way, to keeping
        the data.
      */}
      {volume !== undefined && (
        <Readout label={t("volumeLabel")}>
          {t("volumeValue", {
            mountPath: volume.mountPath,
            used: sized(volume.currentSizeMB),
            size: sized(volume.sizeMB),
          })}
        </Readout>
      )}
    </dl>
  );
}

/**
 * One label/value pair.
 *
 * `mono` on the value rather than the label: these numbers change under the reader, and a
 * proportional font makes the whole row shuffle sideways every time one does. The row above
 * already uses mono for the image line, so this is the register the panel is in.
 */
function Readout({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <Text asChild variant="caption" tone="subtle">
        <dt>{label}</dt>
      </Text>
      <Text asChild variant="mono">
        <dd>{children}</dd>
      </Text>
    </div>
  );
}
