"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { LIMITS } from "@/lib/constants";
import type { ActionField } from "@/lib/action-result";
import type { RegionOption } from "@/lib/railway/types";
import { Field } from "./ui/field";
import { Input } from "./ui/input";
import { NativeSelect } from "./ui/select";

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
 * Controlled rather than uncontrolled, and that is the half that had to be measured rather
 * than assumed. React resets an uncontrolled form once a function action returns — the same
 * behaviour `guardDuplicate` in spin-up-form.tsx works around — and it does so whatever the
 * action answered. So an uncontrolled panel is wiped by a FAILED submission, which is the
 * one moment somebody needs what they typed: they are being told to change one number, with
 * the other six gone. One `useState` holding all seven keeps the values across a failure and
 * lets the remount clear them on success, which is exactly the two behaviours wanted.
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
    (field: keyof typeof BLANK) =>
    (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setValues((current) => ({ ...current, [field]: event.target.value }));

  const onChange = {
    region: change("region"),
    replicas: change("replicas"),
    cpu: change("cpu"),
    memory: change("memory"),
    restartPolicy: change("restartPolicy"),
    restartRetries: change("restartRetries"),
    startCommand: change("startCommand"),
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
   * A native select has no empty state of its own — it shows its first option — so "let
   * Railway choose" has to be a row someone can select their way back to after picking
   * Frankfurt. Its value is the empty string, which is exactly what the schema reads as
   * absence.
   */
  const regionOptions = [
    { value: "", label: t("regionDefault") },
    ...regions.map((region) => ({
      value: region.id,
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
    <>
      {/* The same flex-wrap idiom the image/name/port row uses, for the reason stated
          there: it is how the whole app adapts, and there is no other `md:` in src/. */}
      <div className="flex flex-wrap gap-4">
        <div className="min-w-0 grow basis-56">
          <NativeSelect
            name="region"
            label={t("regionLabel")}
            hint={t("regionHint")}
            options={regionOptions}
            /*
             * One option is no choice: when the read answered with nothing, the control says
             * so instead of offering a list whose only row is "let Railway choose".
             */
            {...(regionsUnavailable
              ? { disabled: true, disabledReason: t("regionUnavailable") }
              : {})}
            disabled={disabled || regionsUnavailable}
            value={values.region}
            onChange={onChange.region}
          />
        </div>

        <div className="min-w-0 grow basis-32">
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
        </div>
      </div>

      <div className="flex flex-wrap gap-4">
        <div className="min-w-0 grow basis-32">
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
        </div>

        <div className="min-w-0 grow basis-32">
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
        </div>
      </div>

      <div className="flex flex-wrap gap-4">
        <div className="min-w-0 grow basis-48">
          <NativeSelect
            name="restartPolicy"
            label={t("restartPolicyLabel")}
            hint={t("restartPolicyHint")}
            options={restartOptions}
            value={values.restartPolicy}
            onChange={onChange.restartPolicy}
            disabled={disabled}
          />
        </div>

        <div className="min-w-0 grow basis-32">
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
        </div>
      </div>

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
    </>
  );
}
