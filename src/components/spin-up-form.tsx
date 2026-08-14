"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { spinUp } from "@/app/dashboard/actions";
import type { ActionResult } from "@/lib/action-result";
import { LIMITS } from "@/lib/constants";
import { DEFAULT_IMAGE, PRESETS, presetVariableDefaults } from "@/lib/presets";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Combobox } from "./ui/combobox";
import { Field } from "./ui/field";
import { Input } from "./ui/input";
import { KeyValueEditor, type KeyValueRow } from "./ui/key-value-editor";
import { PendingStatus } from "./ui/misc";
import { Text } from "./ui/text";
import { useToast } from "./ui/toast";

/** A row plus what the form needs to know about where it came from. */
type VariableRow = KeyValueRow & {
  origin: "preset" | "user";
  /** Whether a person has edited either cell since it was seeded. */
  touched: boolean;
};

const PRESET_ORIGIN = "preset" as const;
const USER_ORIGIN = "user" as const;

/** Catalog defaults as locked rows: the name is the catalog's, the value is the user's. */
function seedRows(image: string): VariableRow[] {
  return presetVariableDefaults(image).map((variable) => ({
    // Stable across a reseed, so switching images and back does not move focus.
    id: `preset-${variable.name}`,
    name: variable.name,
    value: variable.value,
    locked: true,
    generatedWhenBlank: variable.generated,
    origin: PRESET_ORIGIN,
    touched: false,
  }));
}

const isVariableField = (field: string | undefined) =>
  field === "variableKey" || field === "variableValue";

/** Whether a failure names a row, as opposed to the list as a whole. */
const hasIndex = (result: ActionResult) => !result.ok && result.index !== undefined;

/**
 * The rows an image change should leave behind.
 *
 * One rule: nothing a person typed is thrown away by changing the image. A touched preset
 * row survives and stops being locked, since the catalog that owned its name is gone; an
 * untouched one is replaced. A user row whose name collides with a new preset default wins,
 * and that default is not seeded — which is what keeps the duplicate rule from firing on
 * something the app itself created.
 */
function reseed(rows: readonly VariableRow[], image: string): VariableRow[] {
  const keep = rows
    .filter((row) => row.origin === USER_ORIGIN || row.touched)
    .map((row) => ({ ...row, locked: false }));
  const seeded = seedRows(image).filter(
    (row) => !keep.some((kept) => kept.name === row.name),
  );
  return [...seeded, ...keep];
}

export function SpinUpForm({
  projectId,
  environmentId,
  disabled,
}: {
  projectId: string;
  environmentId: string;
  disabled?: boolean;
}) {
  const t = useTranslations("spinUp");
  const tPresets = useTranslations("presets");
  const router = useRouter();
  const { toast } = useToast();
  const [result, formAction, pending] = useActionState<ActionResult | null, FormData>(
    spinUp,
    null,
  );
  /*
   * The refresh gets its own transition so the wait for the fresh list is observable.
   * A bare router.refresh() runs for two Railway round trips with nothing on screen
   * marked busy: the toast has already fired and the submit button has gone idle, so
   * the row simply appears at an unpredictable later moment.
   */
  const [refreshing, startRefresh] = useTransition();
  const [image, setImage] = useState<string>(DEFAULT_IMAGE);
  const [rows, setRows] = useState<VariableRow[]>(() => seedRows(DEFAULT_IMAGE));

  /*
   * The current image, readable from the result effect without being a dependency of it.
   *
   * Depending on `image` there would re-run that effect on every image change, with the
   * same stale `result` still in hand — firing the success toast again and looping
   * router.refresh(). That is ADR-7's hazard in its other form: the dependency is stable
   * here precisely because it is not reactive.
   */
  const imageRef = useRef(DEFAULT_IMAGE);

  /*
   * Reseeded here rather than in an effect keyed on `image`. The rule in `reseed` needs to
   * know what the image *was*, and an effect only sees what it now is — so an effect would
   * have to keep a previous-value ref to say the same thing, and would run once on mount
   * for a change that never happened.
   */
  const changeImage = (next: string) => {
    setImage(next);
    imageRef.current = next;
    setRows((current) => reseed(current, next));
  };

  /**
   * Re-attaches the provenance the editor does not carry.
   *
   * `KeyValueEditor` is domain-free — it holds rows of two strings and knows nothing about
   * catalogs — so `origin` and `touched` are matched back on here by row id. A row the
   * editor invented is a user row, and any edit to either cell marks it touched, which is
   * what stops the next image change from discarding it.
   */
  const changeRows = (next: KeyValueRow[]) => {
    setRows(
      next.map((row) => {
        const previous = rows.find((candidate) => candidate.id === row.id);
        return {
          ...row,
          origin: previous?.origin ?? USER_ORIGIN,
          touched:
            previous === undefined ||
            previous.touched ||
            previous.name !== row.name ||
            previous.value !== row.value,
        };
      }),
    );
  };

  /*
   * Labels and group headings are catalog keys, resolved here. The catalog is a plain
   * module so the same entries can be read on both sides: here for the image list and the
   * editor's default rows, and in the Server Action to decide which names it may mint a
   * credential for. See presetVariableDefaults() and resolveVariables().
   */
  const presetOptions = PRESETS.map((preset) => ({
    value: preset.value,
    label: tPresets(`labels.${preset.labelKey}`),
    group: tPresets(`groups.${preset.groupKey}`),
  }));
  // Uncontrolled: nothing else reads the name, so clearing it on success is a DOM
  // write rather than a setState inside an effect.
  const nameRef = useRef<HTMLInputElement>(null);

  /*
   * Resolved during render, not inside the effect. `useTranslations` returns a fresh
   * function identity on every render, so depending on `t` re-ran this effect
   * continuously — which fired the same toast dozens of times and called
   * router.refresh() in a loop. A plain string dependency is stable.
   */
  const failedTitle = t("failedTitle");

  /*
   * Rows that actually reach FormData, in the order they reach it. A blank row carries no
   * `name` attribute and so is not submitted at all, which is why an error's index counts
   * over this list rather than over what is on screen.
   */
  const submittedRows = rows.filter((row) => row.name !== "" || row.value !== "");

  const rowError =
    result &&
    !result.ok &&
    (result.field === "variableKey" || result.field === "variableValue") &&
    result.index !== undefined
      ? {
          rowId: submittedRows[result.index]?.id ?? "",
          cell: result.field === "variableKey" ? ("name" as const) : ("value" as const),
          message: result.error,
        }
      : undefined;

  useEffect(() => {
    if (!result) return;
    if (result.ok) {
      if (nameRef.current) nameRef.current.value = "";
      /*
       * User rows are cleared and the preset defaults re-seeded, matching the name field
       * rather than the image. A leftover variable set silently applied to the next
       * container is worse than a leftover name: nothing on screen says the last
       * spin-up's environment is still armed.
       */
      setRows(seedRows(imageRef.current));
      toast({ title: result.message, tone: "success" });
      startRefresh(() => router.refresh());
    } else if (!result.field || (isVariableField(result.field) && !hasIndex(result))) {
      /*
       * Field-attributed errors render inline next to the input instead — except a
       * variable error with no row to attach it to (too many rows, too large together),
       * which would otherwise be swallowed silently.
       */
      toast({ title: failedTitle, description: result.error, tone: "error" });
    }
  }, [result, router, toast, failedTitle, startRefresh]);

  const fieldError = (field: "name" | "image") =>
    result && !result.ok && result.field === field ? result.error : undefined;

  return (
    <Card className="p-4">
      <form action={formAction} className="space-y-4">
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="environmentId" value={environmentId} />

        {/*
          One row where both fit, stacked where they do not. `flex-wrap` rather than a
          `md:` grid because that is how the whole app adapts — there is no other `md:`
          in src/ — and the row stacks on its own below roughly 464px of card interior.

          The widths live on wrappers because neither Field nor Combobox takes a
          className, and `min-w-0` is load-bearing: a flex item's default minimum is its
          content, so the long image hint would otherwise refuse to let the column shrink
          to its share. `grow basis-*` rather than `flex-1 basis-*` — `flex-1` sets
          flex-basis itself, so the two would be a same-property conflict resolved by
          Tailwind's ordering rather than by what is written here.

          Image is the wider of the two: its value is a registry reference, and the preset
          popup is sized to this trigger and shows a label and a full ref side by side.
        */}
        <div className="flex flex-wrap gap-4">
          <div className="min-w-0 grow basis-64">
            {/*
              One control, not two. The chip row and the text field were the same value
              shown twice — typing a reference that matched no chip silently deselected
              all of them, which is combobox behaviour built out of two controls that
              could disagree.

              The list is the catalog; free text is still the contract. Anything the
              server's IMAGE_PATTERN accepts can be typed here, and anything it rejects
              still reaches the server so that rule stays the only definition of valid.
            */}
            <Combobox
              label={t("imageLabel")}
              hint={t("imageHint")}
              error={fieldError("image")}
              name="image"
              value={image}
              onValueChange={changeImage}
              options={presetOptions}
              placeholder={t("imagePlaceholder")}
              noMatchesLabel={t("imageNoMatches")}
              toggleLabel={t("imageToggle")}
              listLabel={t("imageListLabel")}
              inputClassName="font-mono"
            />
          </div>

          <div className="min-w-0 grow basis-48">
            <Field
              label={t("nameLabel")}
              hint={t("nameHint")}
              error={fieldError("name")}
            >
              {(field) => (
                <Input
                  {...field}
                  ref={nameRef}
                  name="name"
                  defaultValue=""
                  placeholder={t("namePlaceholder")}
                  autoComplete="off"
                  required
                />
              )}
            </Field>
          </div>
        </div>

        {/*
          After the name field in DOM order, and that placement is asserted: the keyboard
          spec pins Image → Tab → Name, so an editor rendered between them would break a
          tab order someone deliberately fixed.
        */}
        <KeyValueEditor
          legend={t("variablesLegend")}
          description={t("variablesDescription")}
          rows={rows}
          onRowsChange={changeRows}
          nameFieldName="variableKey"
          valueFieldName="variableValue"
          nameLabel={t("variableNameLabel")}
          valueLabel={t("variableValueLabel")}
          namePlaceholder={t("variableNamePlaceholder")}
          valuePlaceholder={t("variableValuePlaceholder")}
          generatedPlaceholder={t("variableGeneratedPlaceholder")}
          addLabel={t("addVariable")}
          removeLabel={({ name, position }) =>
            name
              ? t("removeVariable", { name })
              : t("removeVariableUnnamed", { position })
          }
          cellLabel={({ label, position }) => `${label} ${position}`}
          addedAnnouncement={(position) => t("variableAdded", { position })}
          removedAnnouncement={({ name, position }) =>
            name
              ? t("variableRemoved", { name })
              : t("variableRemovedUnnamed", { position })
          }
          error={rowError}
          max={LIMITS.VARIABLES_MAX}
          maxReachedLabel={t("variablesFull")}
          disabled={disabled}
        />

        <div className="flex items-center gap-3">
          {/*
            Inert during the refresh too. That is a real cost — but the list a second
            submission would be checked against is the stale one, and spinUp rejects
            duplicate names server-side regardless.
          */}
          <Button
            type="submit"
            variant="primary"
            disabled={disabled}
            pending={pending || refreshing}
            pendingLabel={pending ? t("submitPending") : t("refreshPending")}
          >
            <Plus aria-hidden />
            {t("submit")}
          </Button>
          {disabled && (
            <Text variant="caption" tone="subtle">
              {t("selectProjectFirst")}
            </Text>
          )}
          {/* The button's own label change is not announced; this is. */}
          <PendingStatus
            className="sr-only"
            label={
              pending ? t("announce") : refreshing ? t("refreshAnnounce") : undefined
            }
          />
        </div>
      </form>
    </Card>
  );
}
