"use client";

import {
  startTransition,
  useActionState,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useDashboardSelection } from "@/hooks/use-dashboard-selection";
import { useImageCheck } from "@/hooks/use-image-check";
import { useResolved } from "@/hooks/use-resolved";
import { spinUp } from "@/app/dashboard/actions";
import type { ActionField, ActionResult } from "@/lib/action-result";
import {
  DEFAULT_IMAGE,
  presetFor,
  presetOptions,
  presetVolumeFor,
} from "@/lib/presets";
import {
  portFor,
  reattachProvenance,
  reseed,
  seedRows,
  type VariableRow,
} from "@/lib/spin-up-rows";
import { isUnattributable, rowErrorFor } from "@/lib/variable-rows";
import { newIdempotencyKey } from "@/lib/random-id";
import { managedSlug } from "@/lib/railway/slug";
import type { RegionOption } from "@/lib/railway/types";
import { AdvancedSettings } from "./advanced-settings";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Combobox } from "./ui/combobox";
import { Disclosure } from "./ui/disclosure";
import { Field } from "./ui/field";
import { Input } from "./ui/input";
import { type KeyValueRow } from "./ui/key-value-editor";
import { VariableEditor } from "./variable-editor";
import { PendingStatus } from "./ui/misc";
import { Text } from "./ui/text";
import { useToast } from "./ui/toast";

/**
 * The fields that live behind the Advanced disclosure.
 *
 * Read for one thing only: an inline error inside a closed panel is silence, so a failure
 * naming one of these opens the panel before the browser paints. `region` and
 * `restartPolicy` are absent because neither is an `ActionField` at all — see the note on
 * that type.
 *
 * A second copy of `advancedFields` in lib/validation.ts, and deliberately so: importing
 * that module here would drag zod into /dashboard's first load. `spin-up-form.test.tsx`
 * holds the two together — it may import validation.ts, because a test has no bundle.
 */
export const ADVANCED_FIELDS: ReadonlySet<string> = new Set([
  "replicas",
  "cpu",
  "memory",
  "restartRetries",
  "startCommand",
]);

/** A stable empty list, so the resolved-name seed is not a new array every render. */
const NO_NAMES: readonly string[] = [];

export function SpinUpForm({
  projectId,
  environmentId,
  disabled,
  names,
  regions,
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
  /**
   * Where a container may be created, unawaited, for the Advanced panel's region select.
   *
   * Unawaited on the same terms as `names` and required for the same reason. It differs in
   * one way worth knowing here: an empty array is a designed answer rather than only an
   * unresolved one — the read is allowed to fail into it — so the select says the choice is
   * unavailable instead of rendering a list of nothing. See deployRegions in
   * app/dashboard/data.ts.
   */
  regions: Promise<RegionOption[]>;
}) {
  const t = useTranslations("spinUp");
  const tActions = useTranslations("actions");
  const tPresets = useTranslations("presets");
  const { goToContainers } = useDashboardSelection();
  const { toast } = useToast();
  const [result, formAction, pending] = useActionState<ActionResult | null, FormData>(
    spinUp,
    null,
  );
  const [image, setImage] = useState<string>(DEFAULT_IMAGE);
  const [rows, setRows] = useState<VariableRow[]>(() => seedRows(DEFAULT_IMAGE));
  /*
   * Controlled, unlike the name field beside it, because the catalog writes to it: picking
   * nginx has to be able to put 80 there. An uncontrolled input with a `defaultValue` would
   * only take the seed on mount, which is every image change after the first.
   */
  const [port, setPort] = useState<string>(() => portFor(DEFAULT_IMAGE));
  /** Whether a person has edited the port since the catalog last seeded it. */
  const [portTouched, setPortTouched] = useState(false);
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
  /*
   * The panel, so a validation error inside it can open it. Nothing else reads or writes
   * `open` — see the effect below, and ui/disclosure.tsx on why the primitive holds no state.
   */
  const advancedRef = useRef<HTMLDetailsElement>(null);
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
    /*
     * The port follows the catalog on the same rule the variable rows do: what a person
     * typed survives an image change, what the catalog seeded is replaced.
     *
     * The empty string is a value someone chose, not an absence — clearing the 80 that
     * nginx seeded is how a person says "do not expose this" — so `portTouched` is what
     * separates it from the untouched blank a database preset leaves behind. Without that
     * flag, switching from nginx to redis and back would helpfully re-add the 80 that was
     * just deleted.
     */
    setPort((current) => (portTouched ? current : portFor(next)));
  };

  // The editor is domain-free and hands back rows of two strings; see reattachProvenance.
  const changeRows = (next: KeyValueRow[]) => setRows(reattachProvenance(next, rows));

  /*
   * Labels and group headings are catalog keys, resolved here. The catalog is a plain
   * module so the same entries can be read on both sides: here for the image list and the
   * editor's default rows, and in the Server Action to decide which names it may mint a
   * credential for. See presetVariableDefaults() and resolveVariables().
   */
  const imageOptions = presetOptions(tPresets);
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
   * The navigation, held where the effect below can reach it without depending on it.
   *
   * Same hazard as `failedTitle` directly above, and worse: useDashboardSelection builds
   * a fresh object every render, so `goToContainers` has a new identity each time. In the
   * effect's dependency list that re-runs it with the same successful `result` still in
   * hand — firing the toast again and pushing again, which changes the URL, which renders,
   * which re-runs it. That is exactly the loop the comment above records happening once
   * already with `t`. A string could be resolved during render; a callback cannot, so it
   * goes in a ref instead.
   *
   * Synced in its own effect, declared before the one that reads it: effects run in
   * declaration order after commit, so the ref is current by the time success is handled.
   */
  const goToContainersRef = useRef(goToContainers);
  useEffect(() => {
    goToContainersRef.current = goToContainers;
  });

  const rowError = rowErrorFor(result, rows);

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
      /*
       * Back to the catalog's answer for the image still in the form, and untouched again.
       *
       * The same argument the variable rows make one line up, and it is stronger here: a
       * port left armed from the last spin-up would put the *next* container on the public
       * internet without anything on screen having said so.
       */
      setPort(portFor(imageRef.current));
      setPortTouched(false);
      // The submission this key named is over. Anything typed next is a different
      // container, and must not be answered with this one's result.
      setSubmissionKey(newIdempotencyKey());
      toast({ title: result.message, tone: "success" });
      /*
       * The container this made — and the build logs streaming into it — are on the
       * container tab, carrying the same project and environment.
       *
       * Nothing here marks the wait, and that is a deliberate deletion rather than an
       * omission. This used to be `startRefresh(() => router.refresh())`: a refresh joins
       * the transition that started it, so the button could stay busy across the two
       * Railway reads that followed. A push cannot be reported the same way — Next drives a
       * navigation with a transition of its own, and more to the point /dashboard has a
       * loading.tsx, so the route COMMITS immediately and this form unmounts before any
       * state it set could paint. The container tab's own skeleton is what covers the wait
       * now, which is the better signal anyway: it is on the thing being waited for.
       * e2e/skeleton.spec.ts asserts that, and is what caught two attempts to report it
       * from here instead.
       */
      goToContainersRef.current();
    } else if (ADVANCED_FIELDS.has(result.field ?? "")) {
      /*
       * The error renders inline beside its field like every other one — but that field is
       * inside a panel the person may have collapsed, and an error nobody can see is a form
       * that failed silently. Opening it is a DOM write in the same register as clearing the
       * name input above, and for the same reason: `open` is the platform's own state and
       * nothing else here reads it.
       */
      if (advancedRef.current) advancedRef.current.open = true;
    } else if (isUnattributable(result)) {
      // Everything else renders inline next to its own input. See isUnattributable.
      toast({ title: failedTitle, description: result.error, tone: "error" });
    }
  }, [result, toast, failedTitle]);

  /*
   * Read in an effect rather than with `use`, which is the point of taking a promise at
   * all — see useResolved, which is where that argument and the ordering flag now live. It
   * was written twice the moment the region list arrived beside the name list.
   *
   * `null` rather than `[]` as the region seed, because the two states it would otherwise
   * collapse need different UI: a read that has not answered yet leaves the select alone,
   * and a read that answered with nothing disables it and says so. `[]` cannot tell them
   * apart, and the honest half of the pair is the one that would be lost.
   */
  const takenNames = useResolved<readonly string[]>(names, NO_NAMES);
  const resolvedRegions = useResolved<RegionOption[] | null>(regions, null);
  const regionOptions = resolvedRegions ?? [];
  const regionsUnavailable = resolvedRegions !== null && resolvedRegions.length === 0;

  /**
   * Submission, and the local duplicate check that can decline it.
   *
   * One handler rather than an `action` prop with an `onSubmit` guard in front of it, for
   * the reason ui/form.ts gives and this form has the worst case of: the reset put the two
   * advanced selects back to their defaults on a refusal, which also disabled the retries
   * input, which meant a number still visible on screen was dropped from the retry.
   *
   * `startTransition` around the dispatcher is not decoration. `useActionState` reads
   * whether a transition is active to decide whether it owns one, so a bare call leaves
   * `pending` stuck at false and React says so in the console.
   *
   * The check itself is stale by construction — it knows what the last render knew — and
   * that is the trade it is worth making. It is a typo guard, not a lock; the idempotency
   * key on the submission is what makes a genuine double-submit harmless.
   */
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Before the transition: the advanced panel disables a control or two while a
    // submission is in flight, and a disabled control is skipped by FormData.
    const formData = new FormData(event.currentTarget);

    const typed = nameRef.current?.value ?? "";
    if (typed !== "" && takenNames.includes(managedSlug(typed))) {
      setDuplicate(tActions("duplicateName", { name: typed }));
      return;
    }
    setDuplicate(null);
    startTransition(() => formAction(formData));
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

  const fieldError = (field: ActionField) => {
    // The local check first: it is the more recent statement about this field, and it is
    // the only one when nothing was submitted.
    if (field === "name" && duplicate) return duplicate;
    return result && !result.ok && result.field === field ? result.error : undefined;
  };

  return (
    <Card className="p-4">
      <form onSubmit={handleSubmit} className="space-y-4">
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
              options={imageOptions}
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

          {/*
            Last, and narrow, because it is the only optional field on this form.

            After the name in DOM order for the reason the editor below is: the keyboard
            spec pins Image → Tab → Name, so this had to go on the far side of that pair
            rather than between them.

            `basis-32` against the name's 48 and the image's 64: the widest value it can
            hold is five digits, and a field sized to its content is part of what says this
            one is optional without a sentence having to.
          */}
          <div className="min-w-0 grow basis-32">
            <Field
              label={t("portLabel")}
              hint={t("portHint")}
              error={fieldError("port")}
            >
              {(field) => (
                <Input
                  {...field}
                  name="port"
                  value={port}
                  onChange={(event) => {
                    setPort(event.target.value);
                    setPortTouched(true);
                  }}
                  /*
                   * `inputMode` rather than `type="number"`, which brings a spinner nobody
                   * wants on a port, silently drops non-numeric input the server's own rule
                   * should be refusing, and reports `valueAsNumber: NaN` for text this form
                   * needs to send through untouched so `validation.portInvalid` is what the
                   * user reads. The phone keypad is the half worth having.
                   */
                  inputMode="numeric"
                  placeholder={t("portPlaceholder")}
                  autoComplete="off"
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
        <VariableEditor
          description={t("variablesDescription")}
          rows={rows}
          onRowsChange={changeRows}
          error={rowError}
          disabled={disabled}
        />

        {/*
          Last before the button, and closed. The two fields on this form that every
          spin-up needs are still the two visible ones; everything Railway will otherwise
          default is here, where it costs a click to see and nothing to ignore.

          `key` on the child, never on the `<details>`. `submissionKey` is re-minted only on
          success, so keying this subtree clears every advanced value exactly once per
          container created — the rule the name field and the variable rows already follow —
          while the element around it stays mounted, so a panel someone opened stays open.
          Keying the `<details>` instead looks identical in review and snaps the panel shut
          on every success. It also means the note at `setSubmissionKey` above is
          load-bearing here: re-minting the key on failure too would start throwing away
          settings somebody is in the middle of correcting.
        */}
        <Disclosure ref={advancedRef} summary={t("advancedSummary")}>
          <AdvancedSettings
            key={submissionKey}
            regions={regionOptions}
            regionsUnavailable={regionsUnavailable}
            fieldError={fieldError}
            disabled={disabled}
          />
        </Disclosure>

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
            pending={pending}
            pendingLabel={t("submitPending")}
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
            label={pending ? t("announce") : undefined}
          />
        </div>
      </form>
    </Card>
  );
}
