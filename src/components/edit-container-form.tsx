"use client";

import { useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { editContainer } from "@/app/dashboard/actions";
import type { ActionResult } from "@/lib/action-result";
import { presetFor, presetOptions, presetVolumeFor } from "@/lib/presets";
import type { ContainerVolume } from "@/lib/railway/types";
import { isUnattributable, rowErrorFor } from "@/lib/variable-rows";
import { Banner } from "./ui/banner";
import { Button } from "./ui/button";
import { Combobox } from "./ui/combobox";
import { DialogClose, DialogFooter } from "./ui/dialog";
import { Field } from "./ui/field";
import { onSubmitWith } from "./ui/form";
import { Input } from "./ui/input";
import { type KeyValueRow } from "./ui/key-value-editor";
import { VariableEditor } from "./variable-editor";
import { PendingStatus, Spinner } from "./ui/misc";
import { Text } from "./ui/text";

/** What the variable read returned, or why there is nothing to show yet. */
type VariablesState =
  { status: "loading" } | { status: "ready"; names: string[] } | { status: "failed" };

/**
 * One existing variable, as a row: the name it has, and a value cell that is deliberately
 * empty.
 *
 * The id is derived from the name rather than counted, so a re-read that returns the same
 * set does not move focus.
 */
const seedRows = (names: string[]): KeyValueRow[] =>
  names.map((name) => ({
    id: `existing-${name}`,
    name,
    value: "",
    blankMeans: "unchanged" as const,
  }));

/**
 * The edit form itself, mounted only while its dialog is open.
 *
 * Controlled inputs throughout. That used to be what saved this form from React's automatic
 * reset — see `local/no-function-form-action`, which has since taken the mechanism away
 * from every form here — and it stays because an edit form starts full: the fields are
 * seeded from the row, and seeding a DOM value once at mount is the thing that goes wrong
 * when the row underneath changes.
 *
 * The variable rows arrive separately from the rest of the form, because they cost a Railway
 * round trip and the name and image do not — those are already on the row. So the two halves
 * are in different states on purpose: the top of the form is usable immediately, and the
 * editor below it says what it is waiting for.
 */
export function EditContainerForm({
  serviceId,
  displayName,
  image,
  volume,
  projectId,
  environmentId,
  onDone,
  onError,
}: {
  serviceId: string;
  displayName: string;
  /** Null for a service Railway describes with a repo rather than an image — see ADR-6. */
  image: string | null;
  /**
   * The volume this service already has, if it has one. Undefined is most services.
   *
   * Needed here because editing an image cannot create one. The spin-up form attaches a
   * volume for the six stateful presets as part of the create saga; this form issues no
   * `volumeCreate` at all, so a container moved onto `redis:7-alpine` runs with whatever
   * storage it already had — usually none. The note below is the difference between that
   * being a decision and being a surprise.
   */
  volume: ContainerVolume | undefined;
  projectId: string;
  environmentId: string;
  onDone: (message: string) => void;
  onError: (message: string) => void;
}) {
  const t = useTranslations("editContainer");
  const tCommon = useTranslations("common");
  const tPresets = useTranslations("presets");
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

  const [name, setName] = useState(displayName);
  const [imageRef, setImageRef] = useState(image ?? "");
  const [variables, setVariables] = useState<VariablesState>({ status: "loading" });
  const [rows, setRows] = useState<KeyValueRow[]>([]);

  /*
   * Read once, when this form mounts — which is when the dialog opens, because the dialog
   * mounts its body only while open. Aborted on unmount: closing the dialog before Railway
   * answers should not leave a request running against the rate limit, and the route handler
   * is in the one lane that can be cancelled (see .ai/rules/architecture.md).
   */
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({
      project: projectId,
      environment: environmentId,
      service: serviceId,
    });

    fetch(`/api/service-variables?${params}`, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then((body: { names: string[] }) => {
        setVariables({ status: "ready", names: body.names });
        setRows(seedRows(body.names));
      })
      .catch(() => {
        // An aborted fetch rejects too, and setting state on an unmounted form is the one
        // thing this branch must not do. React 19 no longer warns; the guard is still real.
        if (controller.signal.aborted) return;
        setVariables({ status: "failed" });
      });

    return () => controller.abort();
  }, [projectId, environmentId, serviceId]);

  const imageOptions = presetOptions(tPresets);

  const rowError = rowErrorFor(result, rows);

  const fieldError = (field: "name" | "image") =>
    result && !result.ok && result.field === field ? result.error : undefined;

  /*
   * What the note under the image field says, or null for the cases it says nothing about.
   *
   * The same `presetVolumeFor` / `presetFor` pair the spin-up form consults, and for the
   * same reason: a mount path means the catalog knows this image keeps state and where,
   * `null` from `presetFor` means it has never heard of the image, and a preset the catalog
   * knows keeps nothing is this expression being null. Those two undefineds answer
   * different questions — see the note on `Preset.volume`.
   *
   * **But the sentence is not the spin-up form's**, and that is the point of this being its
   * own block rather than a shared component. A spin-up ATTACHES a volume for a stateful
   * preset, so its note describes storage the container is about to get. This form issues
   * no `volumeCreate` at all: an edit onto `redis:7-alpine` runs on whatever the service
   * already had. The two surfaces say opposite things about the same image, so they cannot
   * share a key — and the risk is only real when the service has no volume, which is why
   * `volume` is consulted before anything is said.
   *
   * Unchanged image says nothing. Somebody who opened this dialog to rename a container or
   * add a variable is not making a storage decision, and a warning about the image they
   * were already running would be a warning about the status quo.
   */
  const storage = (() => {
    if (!imageRef.trim() || imageRef === image) return null;
    if (volume) return null;
    if (presetVolumeFor(imageRef)) return "stateful" as const;
    return presetFor(imageRef) ? null : ("unknown" as const);
  })();

  const submit = (formData: FormData) => {
    startTransition(async () => {
      const outcome = await editContainer(null, formData);
      setResult(outcome);
      if (outcome.ok) {
        onDone(outcome.message);
        return;
      }
      // Everything else renders inline beside its own input. See isUnattributable.
      if (isUnattributable(outcome)) onError(outcome.error);
    });
  };

  return (
    <form onSubmit={onSubmitWith(submit)} className="mt-4 space-y-4">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="environmentId" value={environmentId} />
      <input type="hidden" name="serviceId" value={serviceId} />

      <Field label={t("nameLabel")} hint={t("nameHint")} error={fieldError("name")}>
        {(field) => (
          <Input
            {...field}
            name="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="off"
            required
          />
        )}
      </Field>

      {/*
        The same control spin-up uses, seeded with what the service runs now. Free text is
        still the contract: anything the server's IMAGE_PATTERN accepts can be typed here,
        and anything it rejects still reaches the server so that rule stays the only
        definition of valid.
      */}
      <Combobox
        label={t("imageLabel")}
        hint={t("imageHint")}
        error={fieldError("image")}
        name="image"
        value={imageRef}
        onValueChange={setImageRef}
        options={imageOptions}
        noMatchesLabel={t("imageNoMatches")}
        toggleLabel={t("imageToggle")}
        listLabel={t("imageListLabel")}
        inputClassName="font-mono"
      />

      {storage && (
        <Banner tone="warning">
          {storage === "stateful" ? t("statefulNoVolumeNote") : t("unknownStorageNote")}
        </Banner>
      )}

      {variables.status === "loading" && (
        <Text variant="caption" tone="subtle" className="flex items-center gap-2">
          <Spinner />
          {t("loadingVariables")}
        </Text>
      )}

      {/*
        A refused read does not refuse the form. The name and the image came off the row and
        need nothing from Railway, so the honest thing is to let those two be edited and say
        what will happen to the variables — which is nothing, because an empty editor submits
        no rows and the action reads the prior set itself.
      */}
      {variables.status === "failed" && (
        <Banner tone="warning">{t("variablesUnavailable")}</Banner>
      )}

      {variables.status === "ready" && (
        <VariableEditor
          description={t("variablesDescription")}
          rows={rows}
          onRowsChange={setRows}
          error={rowError}
        />
      )}

      {/* The button's own label change is not announced; this is. */}
      <PendingStatus className="sr-only" label={pending ? t("announce") : undefined} />

      <DialogFooter>
        <DialogClose asChild>
          {/* Dismissing mid-flight unmounts the form and strands the request. */}
          <Button variant="ghost" disabled={pending}>
            {tCommon("cancel")}
          </Button>
        </DialogClose>
        <Button
          type="submit"
          variant="primary"
          pending={pending}
          pendingLabel={t("submitPending")}
        >
          {t("submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}
