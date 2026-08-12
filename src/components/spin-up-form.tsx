"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { spinUp } from "@/app/dashboard/actions";
import type { ActionResult } from "@/lib/action-result";
import { DEFAULT_IMAGE, PRESETS } from "@/lib/presets";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Combobox } from "./ui/combobox";
import { Field } from "./ui/field";
import { Input } from "./ui/input";
import { PendingStatus } from "./ui/misc";
import { Text } from "./ui/text";
import { useToast } from "./ui/toast";

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

  /*
   * Labels and group headings are catalog keys, resolved here. The catalog itself is a
   * plain module so the Server Action can read the same entries' variables without the
   * client ever sending any — see presetFor().
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

  useEffect(() => {
    if (!result) return;
    if (result.ok) {
      if (nameRef.current) nameRef.current.value = "";
      toast({ title: result.message, tone: "success" });
      startRefresh(() => router.refresh());
    } else if (!result.field) {
      // Field-attributed errors render inline next to the input instead.
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
          One control, not two. The chip row and the text field were the same value shown
          twice — typing a reference that matched no chip silently deselected all of them,
          which is combobox behaviour built out of two controls that could disagree.

          The list is the catalog; free text is still the contract. Anything the server's
          IMAGE_PATTERN accepts can be typed here, and anything it rejects still reaches
          the server so that rule stays the only definition of what is valid.
        */}
        <Combobox
          label={t("imageLabel")}
          hint={t("imageHint")}
          error={fieldError("image")}
          name="image"
          value={image}
          onValueChange={setImage}
          options={presetOptions}
          placeholder={t("imagePlaceholder")}
          noMatchesLabel={t("imageNoMatches")}
          toggleLabel={t("imageToggle")}
          listLabel={t("imageListLabel")}
          inputClassName="font-mono"
        />

        <Field label={t("nameLabel")} hint={t("nameHint")} error={fieldError("name")}>
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
