"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { spinUp, type ActionResult } from "@/app/dashboard/actions";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Field } from "./ui/field";
import { Input } from "./ui/input";
import { ToggleGroup } from "./ui/toggle-group";
import { useToast } from "./ui/toast";

/**
 * Images chosen because they stay up with no configuration. A preset that boots and
 * immediately exits (plain `alpine`, or `postgres` without credentials) would show a
 * crash loop and read as a bug in this app rather than in the image.
 */
const PRESETS = [
  { value: "redis:7-alpine", label: "Redis" },
  { value: "nginx:alpine", label: "Nginx" },
  { value: "traefik/whoami", label: "whoami" },
  { value: "httpd:alpine", label: "Apache" },
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
  const router = useRouter();
  const { toast } = useToast();
  const [result, formAction, pending] = useActionState<ActionResult | null, FormData>(
    spinUp,
    null,
  );
  const [image, setImage] = useState<string>(DEFAULT_IMAGE);
  // Uncontrolled: nothing else reads the name, so clearing it on success is a DOM
  // write rather than a setState inside an effect.
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!result) return;
    if (result.ok) {
      if (nameRef.current) nameRef.current.value = "";
      toast({ title: result.message, tone: "success" });
      router.refresh();
    } else if (!result.field) {
      // Field-attributed errors render inline next to the input instead.
      toast({ title: "Could not spin up", description: result.error, tone: "error" });
    }
  }, [result, router, toast]);

  const fieldError = (field: "name" | "image") =>
    result && !result.ok && result.field === field ? result.error : undefined;

  return (
    <Card className="p-4">
      <form action={formAction} className="space-y-4">
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="environmentId" value={environmentId} />

        <div className="space-y-2">
          <p className="text-text text-sm font-medium">Image</p>
          <ToggleGroup
            label="Preset images"
            value={image}
            onValueChange={setImage}
            options={PRESETS.map((p) => ({ value: p.value, label: p.label }))}
          />
          <Field
            label="Image reference"
            hint="Any public Docker image. Private registries are not supported yet."
            error={fieldError("image")}
          >
            {(field) => (
              <Input
                {...field}
                name="image"
                value={image}
                onChange={(e) => setImage(e.target.value)}
                placeholder="redis:7-alpine"
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                required
              />
            )}
          </Field>
        </div>

        <Field
          label="Name"
          hint="Prefixed automatically so this app can tell its own containers apart."
          error={fieldError("name")}
        >
          {(field) => (
            <Input
              {...field}
              ref={nameRef}
              name="name"
              defaultValue=""
              placeholder="cache"
              autoComplete="off"
              required
            />
          )}
        </Field>

        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" disabled={pending || disabled}>
            <Plus aria-hidden />
            {pending ? "Spinning up…" : "Spin up container"}
          </Button>
          {disabled && (
            <span className="text-text-subtle text-xs">
              Select a project and environment first.
            </span>
          )}
        </div>
      </form>
    </Card>
  );
}
