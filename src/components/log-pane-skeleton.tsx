"use client";

import { useTranslations } from "next-intl";
import { Text } from "./ui/text";

/**
 * Stands in for LogPane while its chunk loads.
 *
 * Deliberately not a Skeleton. LogPane's own first frame is already an empty pane
 * showing "Connecting…", so matching it means the log region and its accessible name
 * exist from the moment the row is expanded, and nothing is swapped out when the chunk
 * arrives — the placeholder simply becomes the real thing.
 *
 * The `h-64 rounded-md bg-subtle` box and its `p-3` inset mirror what LogPane passes to
 * ScrollArea. log-pane-skeleton.test.tsx pins both so they cannot drift apart.
 */
export function LogPaneSkeleton() {
  const t = useTranslations("containers");

  return (
    <div className="relative">
      <div
        role="log"
        aria-busy="true"
        aria-label={t("logsLabel")}
        className="bg-subtle h-64 rounded-md p-3"
      >
        <Text asChild variant="mono" tone="muted">
          <p>{t("connecting")}</p>
        </Text>
      </div>
    </div>
  );
}
