"use client";

import {
  useActionState,
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { spinUp } from "@/app/dashboard/actions";
import type { ActionResult } from "@/lib/action-result";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Field } from "./ui/field";
import { Input } from "./ui/input";
import { PendingStatus } from "./ui/misc";
import { ToggleGroup } from "./ui/toggle-group";
import { useToast } from "./ui/toast";

/**
 * Images chosen because they stay up with no configuration. A preset that boots and
 * immediately exits (plain `alpine`, or `postgres` without credentials) would show a
 * crash loop and read as a bug in this app rather than in the image.
 */
const PRESETS = [
  { value: "redis:7-alpine", labelKey: "presetRedis" },
  { value: "nginx:alpine", labelKey: "presetNginx" },
  { value: "traefik/whoami", labelKey: "presetWhoami" },
  { value: "httpd:alpine", labelKey: "presetApache" },
] as const;

const DEFAULT_IMAGE = PRESETS[0].value;

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
  const imageGroupId = useId();
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

        {/* The heading is visual grouping; role+labelledby makes it programmatic too. */}
        <div className="space-y-2" role="group" aria-labelledby={imageGroupId}>
          <p id={imageGroupId} className="text-text text-sm font-medium">
            {t("imageGroup")}
          </p>
          <ToggleGroup
            label={t("presetImages")}
            value={image}
            onValueChange={setImage}
            options={PRESETS.map((p) => ({ value: p.value, label: t(p.labelKey) }))}
          />
          <Field
            label={t("imageLabel")}
            hint={t("imageHint")}
            error={fieldError("image")}
          >
            {(field) => (
              <Input
                {...field}
                name="image"
                value={image}
                onChange={(e) => setImage(e.target.value)}
                placeholder={t("imagePlaceholder")}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                required
              />
            )}
          </Field>
        </div>

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
            <span className="text-text-subtle text-xs">{t("selectProjectFirst")}</span>
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
