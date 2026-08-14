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
 * The `h-pane-log rounded-md bg-subtle` box and its `p-3` inset mirror what LogPane passes to
 * ScrollArea. log-pane-skeleton.test.tsx pins both so they cannot drift apart.
 */
export function LogPaneSkeleton() {
  const t = useTranslations("containers");

  return (
    <div className="relative">
      {/*
        Reserves the row LogPane's toolbar occupies, so the panel does not grow by a
        control's height when the chunk lands.

        Deliberately the placeholder and not the toolbar itself: importing it here would
        pull it and its icons out of the pane's dynamic chunk and into /dashboard's first
        load, for every visitor who never expands a row. log-pane-skeleton.test.tsx pins
        the height against the real thing so the two cannot drift.
      */}
      <div data-log-toolbar aria-hidden className="h-control-md mb-2" />
      <div
        role="log"
        aria-busy="true"
        aria-label={t("logsLabel")}
        className="bg-subtle h-pane-log rounded-md p-3"
      >
        <Text asChild variant="mono" tone="muted">
          <p>{t("connecting")}</p>
        </Text>
      </div>
    </div>
  );
}
