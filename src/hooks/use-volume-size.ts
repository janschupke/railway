"use client";

import { useCallback } from "react";
import { useLocale, useTranslations } from "next-intl";
import { formatVolumeMb } from "@/lib/format";

/**
 * A volume size in megabytes, rendered as a sentence fragment in the reader's locale.
 *
 * A hook rather than a function because the unit is copy: `lib/format.ts` returns the
 * number and a `"gb" | "mb"` discriminant precisely so that nothing under `src/lib` ever
 * writes "MB", and turning that discriminant into a string needs the translator. Two
 * components need the same fragment — the row's readout says how much of the volume is
 * used, and the destroy dialog says how much is about to be deleted — and a second copy of
 * this three-line branch is how the two would drift into rendering the same volume
 * differently.
 *
 * Never null: a size Railway did answer is always renderable, and the em dash belongs to
 * the readouts that can genuinely have no sample.
 */
export function useVolumeSize(): (megabytes: number) => string {
  const t = useTranslations("containers");
  const tCommon = useTranslations("common");
  const locale = useLocale();

  return useCallback(
    (megabytes: number) => {
      const figure = formatVolumeMb(megabytes, locale);
      if (!figure) return tCommon("noValue");
      return figure.unit === "gb"
        ? t("memoryValueGb", { value: figure.value })
        : t("memoryValueMb", { value: figure.value });
    },
    [t, tCommon, locale],
  );
}
