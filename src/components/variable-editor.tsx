"use client";

import { useTranslations } from "next-intl";
import { LIMITS } from "@/lib/constants";
import type { RowError } from "@/lib/variable-rows";
import { KeyValueEditor, type KeyValueRow } from "./ui/key-value-editor";

/**
 * The environment-variable editor, as both forms that own one actually use it.
 *
 * `KeyValueEditor` is domain-free by design — it knows about names and values, not about
 * Railway — so every caller has to say what a row is called, how to announce adding one,
 * and what the limit is. Spin-up and edit answered all of that identically: twenty-one of
 * the twenty-two props matched, including four label factories that were the same
 * character for character, in two files four hundred lines apart.
 *
 * The copy had already been duplicated to match. Thirteen of the fourteen catalog strings
 * were byte-identical under `spinUp` and `editContainer`, which is two places to edit for
 * one change to the wording and no way to notice the second was missed — so they are one
 * `variables` namespace now. Only the description genuinely differs between the two forms
 * (one explains generated values, the other explains that blank keeps what is set), and
 * that is the prop.
 */
export function VariableEditor({
  description,
  rows,
  onRowsChange,
  error,
  disabled,
}: {
  /** Why this form's variables behave the way they do — the one string that differs. */
  description: string;
  rows: KeyValueRow[];
  onRowsChange: (rows: KeyValueRow[]) => void;
  error?: RowError;
  disabled?: boolean;
}) {
  const t = useTranslations("variables");

  return (
    <KeyValueEditor
      legend={t("legend")}
      description={description}
      rows={rows}
      onRowsChange={onRowsChange}
      nameFieldName="variableKey"
      valueFieldName="variableValue"
      nameLabel={t("nameLabel")}
      valueLabel={t("valueLabel")}
      namePlaceholder={t("namePlaceholder")}
      valuePlaceholder={t("valuePlaceholder")}
      generatedPlaceholder={t("generatedPlaceholder")}
      /*
       * Passed unconditionally, including from spin-up, which cannot reach it: the editor
       * reads it only for a row marked `blankMeans: "unchanged"`, and only the edit form
       * seeds those. A prop that is inert by construction beats a caller having to know it.
       */
      unchangedPlaceholder={t("existingPlaceholder")}
      addLabel={t("add")}
      removeLabel={({ name, position }) =>
        name ? t("remove", { name }) : t("removeUnnamed", { position })
      }
      cellLabel={({ label, position }) => `${label} ${position}`}
      addedAnnouncement={(position) => t("added", { position })}
      removedAnnouncement={({ name, position }) =>
        name ? t("removed", { name }) : t("removedUnnamed", { position })
      }
      error={error}
      max={LIMITS.VARIABLES_MAX}
      maxReachedLabel={t("full")}
      disabled={disabled}
    />
  );
}
