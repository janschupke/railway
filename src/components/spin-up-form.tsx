"use client";

import {
  useActionState,
  useEffect,
  useRef,
  useState,
  useTransition,
  type FormEvent,
} from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useImageCheck } from "@/hooks/use-image-check";
import { spinUp } from "@/app/dashboard/actions";
import type { ActionResult } from "@/lib/action-result";
import { LIMITS } from "@/lib/constants";
import {
  DEFAULT_IMAGE,
  PRESETS,
  presetFor,
  presetVariableDefaults,
  presetVolumeFor,
} from "@/lib/presets";
import { newIdempotencyKey } from "@/lib/random-id";
import { managedSlug } from "@/lib/railway/slug";
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
    ...(variable.generated ? { blankMeans: "generated" as const } : {}),
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
  names,
}: {
  projectId: string;
  environmentId: string;
  disabled?: boolean;
  /**
   * The managed container names already in this environment, unawaited.
   *
   * A promise rather than an array because the list is fetched inside a Suspense boundary
   * below this form, and awaiting it in the page would put that round trip back in front
   * of the form. Required rather than optional so the page cannot quietly stop passing it
   * and lose the check with nothing to show for it.
   */
  names: Promise<string[]>;
}) {
  const t = useTranslations("spinUp");
  const tActions = useTranslations("actions");
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
   * Names this submission, so the server can recognise a repeat of it.
   *
   * Minted once and re-minted only on success, which is the whole rule. A submission that
   * failed left nothing on Railway and released its key, so pressing the button again with
   * the same one is a retry and must be allowed to run; a submission that succeeded is
   * finished, and the next one is a different container that must not be answered with the
   * last one's result. `useId` would be neither — it is stable for the life of the
   * component, so every spin-up in a session would carry the same key.
   */
  const [submissionKey, setSubmissionKey] = useState(newIdempotencyKey);
  const [takenNames, setTakenNames] = useState<readonly string[]>([]);
  /*
   * The local half of what used to be a server-side lookup. Held separately from `result`
   * because no submission produced it: nothing was sent.
   */
  const [duplicate, setDuplicate] = useState<string | null>(null);

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
      // The submission this key named is over. Anything typed next is a different
      // container, and must not be answered with this one's result.
      setSubmissionKey(newIdempotencyKey());
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

  /*
   * Read in an effect rather than with `use`, which is the point of taking a promise at
   * all: `use` would suspend this form until the container list arrived, and the whole
   * reason that list sits behind its own boundary is so the form does not wait for it.
   *
   * A fresh promise arrives on every render of the page, which is how the check learns
   * about the container this form just made. The flag is for the ordering that follows
   * from that: a slow earlier read must not land on top of a newer one.
   */
  useEffect(() => {
    let live = true;
    void names.then((resolved) => {
      if (live) setTakenNames(resolved);
    });
    return () => {
      live = false;
    };
  }, [names]);

  /**
   * The check that replaced the server's, at no round trip.
   *
   * `preventDefault` rather than wrapping `formAction` in a function of our own: React
   * resets an uncontrolled form once a function action returns, so a wrapper that declined
   * to submit would clear the name field while telling the user to change the name in it.
   *
   * Stale by construction — it knows what the last render knew — and that is the trade
   * this is worth making. It is a typo guard, not a lock; the idempotency key on the
   * submission is what makes a genuine double-submit harmless.
   */
  const guardDuplicate = (event: FormEvent<HTMLFormElement>) => {
    const typed = nameRef.current?.value ?? "";
    if (typed !== "" && takenNames.includes(managedSlug(typed))) {
      event.preventDefault();
      setDuplicate(tActions("duplicateName", { name: typed }));
      return;
    }
    setDuplicate(null);
  };

  /*
   * Advisory, and only ever advisory.
   *
   * `unavailable` is the one status that puts anything on screen. A registry outage, a
   * rate limit, a reference on a registry this app will not dereference and a check that
   * has not answered yet are all silent — a spin-up that did not happen because a registry
   * was having a bad day is a worse outcome than the failed deployment this warns about.
   *
   * It does not gate the submit button, it does not set `aria-invalid`, and Field ranks a
   * real validation error above it — so a reference the server will refuse says so instead
   * of saying this.
   */
  const imageUnavailable = useImageCheck(image) === "unavailable";

  /*
   * What the note under the image field says, or null for the case it says nothing about.
   *
   * A `mountPath` means the catalog knows this image keeps state and where; `null` means it
   * has never heard of the image at all. The third case — a preset the catalog knows keeps
   * nothing — is this whole expression being null, which is why `presetFor` is consulted
   * separately rather than inferring "no volume" from `presetVolumeFor` alone. Those two
   * undefineds answer different questions; see the note on `Preset.volume`.
   *
   * Blank input is nothing: the field starts empty on a form nobody has touched, and a
   * warning about an image the person has not chosen yet is a warning about nothing.
   */
  const storage = (() => {
    if (!image.trim()) return null;
    const volume = presetVolumeFor(image);
    if (volume) return { mountPath: volume.mountPath };
    return presetFor(image) ? null : { mountPath: null };
  })();

  const fieldError = (field: "name" | "image") => {
    // The local check first: it is the more recent statement about this field, and it is
    // the only one when nothing was submitted.
    if (field === "name" && duplicate) return duplicate;
    return result && !result.ok && result.field === field ? result.error : undefined;
  };

  return (
    <Card className="p-4">
      <form action={formAction} onSubmit={guardDuplicate} className="space-y-4">
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="environmentId" value={environmentId} />
        <input type="hidden" name="idempotencyKey" value={submissionKey} />

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
              {...(imageUnavailable ? { warning: t("imageUnavailable") } : {})}
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

            {/*
              What this image does with data it is given, said before it is created rather
              than discovered afterwards.

              Three cases and only two sentences, which is the decision here. A preset the
              catalog knows keeps state says where its volume mounts. An image matching no
              preset says the app does not know where it stores data — that is the honest
              statement, and it is the one that covers `couchdb:3`, `influxdb:2` and every
              private image. A preset with no volume says NOTHING: the catalog has checked
              that nginx and whoami keep nothing worth keeping, and a warning there would be
              noise that teaches people to skip the one above.

              Not a Banner. Nothing is wrong, nothing needs acknowledging, and Banner
              carries a role that would announce this to a screen reader on every keystroke
              that changes the image. It is the same quiet caption the prefix note under the
              container list uses.
            */}
            {storage && (
              <Text asChild variant="caption" tone="subtle">
                <p className="mt-1.5">
                  {storage.mountPath
                    ? t("volumeNote", { mountPath: storage.mountPath })
                    : t("unknownStorageNote")}
                </p>
              </Text>
            )}
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
            submission would be checked against is the stale one, and the idempotency key
            on the submission is what makes a repeat harmless regardless.
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
