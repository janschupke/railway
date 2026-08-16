"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { LIMITS } from "@/lib/constants";
import type { ActionField } from "@/lib/action-result";
import type { RegionOption } from "@/lib/railway/types";
import { Field } from "./ui/field";
import { Input } from "./ui/input";
import { Select } from "./ui/select";

/** Every advanced field blank, which is what "leave it all to Railway" is spelled as. */
const BLANK = {
  region: "",
  replicas: "",
  cpu: "",
  memory: "",
  restartPolicy: "",
  restartRetries: "",
  startCommand: "",
};

/**
 * The resource controls, as the seven fields Railway will actually accept.
 *
 * Its own component rather than more JSX in the form, for one reason that is not tidiness:
 * the form renders it with `key={submissionKey}`, so a successful spin-up remounts this
 * subtree and every value goes back to blank with no clearing code anywhere. The `<details>`
 * element stays mounted around it, so the panel does not snap shut under someone who had
 * just opened it.
 *
 * Controlled rather than uncontrolled, and the reason has changed since ADR-7 recorded it.
 * The measurement then was that React reset a `<form action={fn}>` whatever the action
 * answered, so an uncontrolled panel was wiped by a FAILED submission — the one moment
 * somebody needs what they typed. No form here takes a function action any more
 * (`local/no-function-form-action`), so that argument has retired and two better ones are
 * left: `retriesApply` below is read during render to disable a control, and the two Radix
 * Selects are controlled by construction. One `useState` holding all seven still keeps the
 * values across a failure and still lets the remount clear them on success.
 *
 * The selects were the part the old mechanism defeated anyway. State kept the five inputs
 * through a refusal and never the two dropdowns: Radix answers a form reset by putting its
 * own value back to whatever it mounted with, which arrives here as an `onValueChange` and
 * overwrites the state that was supposed to be protecting it.
 *
 * ADR-7 covers why seven write-only values in one component are still not a store.
 */
export function AdvancedSettings({
  regions,
  regionsUnavailable,
  fieldError,
  disabled,
}: {
  regions: RegionOption[];
  /** True once the read has answered with nothing, which is a designed state. */
  regionsUnavailable: boolean;
  fieldError: (field: ActionField) => string | undefined;
  disabled?: boolean;
}) {
  const t = useTranslations("spinUp");
  const [values, setValues] = useState(BLANK);

  /*
   * One handler shape for seven controls, bound once each rather than inline.
   *
   * Bound here rather than inline in the JSX because the i18n lint
   * rule reads every string literal in JSX as user-facing copy — a field name in an attribute
   * is indistinguishable to it from a sentence, and widening its allowlist to say otherwise
   * is the fix the rules explicitly refuse.
   */
  const change =
    (field: keyof typeof BLANK) => (event: React.ChangeEvent<HTMLInputElement>) =>
      setValues((current) => ({ ...current, [field]: event.target.value }));

  /** The same binding for the two Selects, which report a value rather than an event. */
  const pick = (field: keyof typeof BLANK) => (next: string) =>
    setValues((current) => ({ ...current, [field]: next }));

  const onChange = {
    replicas: change("replicas"),
    cpu: change("cpu"),
    memory: change("memory"),
    restartRetries: change("restartRetries"),
    startCommand: change("startCommand"),
  };

  const onValueChange = {
    region: pick("region"),
    restartPolicy: pick("restartPolicy"),
  };

  /*
   * Retries applies to one policy and is inert under the other two. Disabled rather than
   * hidden, so the panel does not reflow every time the select changes — and load-bearing
   * rather than cosmetic: a disabled input is not submitted at all, so this is what stops a
   * retry count reaching a policy that ignores it. The value is kept in state meanwhile, so
   * switching away and back does not cost somebody the number they typed.
   */
  const retriesApply = values.restartPolicy === "ON_FAILURE";

  /*
   * Blank first, and it is a real option rather than a placeholder.
   *
   * "Let Railway choose" is a choice someone has to be able to make *again* — after
   * picking Frankfurt, there has to be a row that takes them back — and a placeholder is
   * only ever the absence of one. Its value is the empty string, which is what the schema
   * reads as absence; `Select` maps it onto its own sentinel and back, because Radix will
   * not hold an empty-valued item.
   */
  const regionOptions = [
    { value: "", label: t("regionDefault") },
    ...regions.map((region) => ({
      value: region.value,
      label: region.label,
      group: region.country,
    })),
  ];

  const restartOptions = [
    { value: "", label: t("restartPolicyDefault") },
    { value: "ON_FAILURE", label: t("restartPolicyOnFailure") },
    { value: "ALWAYS", label: t("restartPolicyAlways") },
    { value: "NEVER", label: t("restartPolicyNever") },
  ];

  return (
    /*
     * One grid over all seven fields, not three flex rows.
     *
     * The rows used to be independent `flex flex-wrap` containers with bases of 56, 32 and
     * 48 mixed between them, so no two of them shared a column edge — Region ran wider than
     * Restart policy, CPU started where neither did, and the panel read as three unrelated
     * strips rather than one form. Tracks are the fix, because a grid is the one layout
     * where the columns are a property of the container instead of a coincidence between
     * siblings.
     *
     * `auto-fit` and a minimum rather than a breakpoint, per the policy the image/name/port
     * row states: there is no `md:` anywhere in src/, and the panel should reflow on the
     * space it actually has. At two tracks the field order preserves the pairs that were
     * already there — region+replicas, cpu+memory, policy+retries — so nothing moves for a
     * reader who knew the old layout.
     *
     * `items-start` keeps every control on the top edge of its row when one field's hint
     * wraps to a second line and its neighbour's does not.
     */
    <div className="grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] items-start gap-4">
      <Select
        name="region"
        label={t("regionLabel")}
        hint={t("regionHint")}
        options={regionOptions}
        /*
         * One option is no choice: when the read answered with nothing, the control says
         * so instead of offering a list whose only row is "let Railway choose".
         */
        {...(regionsUnavailable ? { disabledReason: t("regionUnavailable") } : {})}
        disabled={disabled || regionsUnavailable}
        value={values.region}
        onValueChange={onValueChange.region}
      />

      <Field
        label={t("replicasLabel")}
        hint={t("replicasHint")}
        error={fieldError("replicas")}
      >
        {(field) => (
          <Input
            {...field}
            name="replicas"
            value={values.replicas}
            onChange={onChange.replicas}
            /*
             * `inputMode` rather than `type="number"`, on the argument the port field
             * already makes: a spinner nobody wants, silently dropped non-numeric input
             * the server's own rule should be refusing, and `valueAsNumber: NaN` for text
             * this form needs to send through so the catalog sentence is what is read.
             */
            inputMode="numeric"
            placeholder={t("replicasPlaceholder", { max: LIMITS.REPLICAS_MAX })}
            autoComplete="off"
            disabled={disabled}
          />
        )}
      </Field>

      <Field label={t("cpuLabel")} hint={t("cpuHint")} error={fieldError("cpu")}>
        {(field) => (
          <Input
            {...field}
            name="cpu"
            value={values.cpu}
            onChange={onChange.cpu}
            // `decimal`, not `numeric`: a quarter of a vCPU is a real request, and the
            // keypad this asks for is the one with a point on it.
            inputMode="decimal"
            placeholder={t("cpuPlaceholder")}
            autoComplete="off"
            disabled={disabled}
          />
        )}
      </Field>

      <Field
        label={t("memoryLabel")}
        hint={t("memoryHint")}
        error={fieldError("memory")}
      >
        {(field) => (
          <Input
            {...field}
            name="memory"
            value={values.memory}
            onChange={onChange.memory}
            inputMode="decimal"
            placeholder={t("memoryPlaceholder")}
            autoComplete="off"
            disabled={disabled}
          />
        )}
      </Field>

      <Select
        name="restartPolicy"
        label={t("restartPolicyLabel")}
        hint={t("restartPolicyHint")}
        options={restartOptions}
        value={values.restartPolicy}
        onValueChange={onValueChange.restartPolicy}
        disabled={disabled}
      />

      <Field
        label={t("restartRetriesLabel")}
        hint={t("restartRetriesHint")}
        error={fieldError("restartRetries")}
      >
        {(field) => (
          <Input
            {...field}
            name="restartRetries"
            value={values.restartRetries}
            onChange={onChange.restartRetries}
            inputMode="numeric"
            placeholder={t("restartRetriesPlaceholder")}
            autoComplete="off"
            // See `retriesApply` above. The action drops a stray retry count too, for a
            // request that did not come from this form.
            disabled={disabled || !retriesApply}
          />
        )}
      </Field>

      {/* The one field with no natural partner: a command is a sentence, and half a row
          of monospace is not enough of it to read. */}
      <div className="col-span-full">
        <Field
          label={t("startCommandLabel")}
          hint={t("startCommandHint")}
          error={fieldError("startCommand")}
        >
          {(field) => (
            <Input
              {...field}
              name="startCommand"
              value={values.startCommand}
              onChange={onChange.startCommand}
              placeholder={t("startCommandPlaceholder")}
              autoComplete="off"
              className="font-mono"
              disabled={disabled}
            />
          )}
        </Field>
      </div>
    </div>
  );
}
