"use client";

import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { isTransitioning, type ContainerState } from "@/lib/railway/types";

/**
 * Container lifecycle indicator.
 *
 * Colour comes from a `data-state-color` attribute resolved against design tokens in
 * globals.css, not from a lookup table of Tailwind class strings. Adding a state means
 * adding a token, not editing two maps in here.
 *
 * The raw Railway enum is exposed to assistive technology rather than hidden in a
 * `title` attribute, which keyboard and screen-reader users never see.
 */
export function StatusBadge({
  state,
  rawStatus,
}: {
  state: ContainerState;
  rawStatus?: string | null;
}) {
  const t = useTranslations();
  const label = t(`states.${state}`);

  return (
    <span
      data-state-color={state}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
      )}
    >
      <span
        aria-hidden
        data-state-dot
        className={cn(
          "size-1.5 rounded-full",
          isTransitioning(state) && "animate-pulse-dot",
        )}
      />
      {label}
      {rawStatus && rawStatus !== label && (
        <span className="sr-only">
          {t("containers.rawStatus", { status: rawStatus })}
        </span>
      )}
    </span>
  );
}
