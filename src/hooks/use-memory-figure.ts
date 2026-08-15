"use client";

import { useCallback } from "react";
import { useLocale, useTranslations } from "next-intl";
import { formatMemoryGb, formatVolumeMb } from "@/lib/format";

/**
 * A memory figure, rendered as a sentence fragment in the reader's locale.
 *
 * Hooks rather than functions because the unit is copy: `lib/format.ts` returns the number
 * and a `"gb" | "mb"` discriminant precisely so that nothing under `src/lib` ever writes
 * "MB", and turning that discriminant into a string needs the translator. Four call sites
 * want the identical three-line branch — the row's volume readout, the destroy dialog's
 * checkbox, and both halves of the metrics readout's `35 MB of 1.0 GB` — and a second copy
 * of it is how two of them would drift into rendering the same figure differently.
 *
 * Two entry points over one shared branch, because the two figures come off the same API in
 * different units: `MEMORY_USAGE_GB` is gigabytes and `VolumeInstance.sizeMB` is megabytes.
 * The division lives in `formatVolumeMb`, not at a call site, for the reason that function
 * gives — a component dividing inline is a component that can divide by 1024 next time.
 *
 * Never null: a size Railway did answer is always renderable, and the em dash belongs to the
 * readouts that can genuinely have no sample.
 */
function useUnitFragment(): (
  figure: { value: string; unit: "gb" | "mb" } | null,
) => string {
  const t = useTranslations("containers");
  const tCommon = useTranslations("common");

  return useCallback(
    (figure) => {
      if (!figure) return tCommon("noValue");
      return figure.unit === "gb"
        ? t("memoryValueGb", { value: figure.value })
        : t("memoryValueMb", { value: figure.value });
    },
    [t, tCommon],
  );
}

/** A volume size, from the megabytes Railway states volumes in. */
export function useVolumeSize(): (megabytes: number) => string {
  const render = useUnitFragment();
  const locale = useLocale();

  return useCallback(
    (megabytes: number) => render(formatVolumeMb(megabytes, locale)),
    [render, locale],
  );
}

/** A memory reading or ceiling, from the gigabytes Railway states memory in. */
export function useMemoryGb(): (gigabytes: number | null) => string {
  const render = useUnitFragment();
  const locale = useLocale();

  return useCallback(
    (gigabytes: number | null) => render(formatMemoryGb(gigabytes, locale)),
    [render, locale],
  );
}
