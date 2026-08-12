"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { spinUp, type ActionResult } from "@/app/dashboard/actions";
import { Banner, Button, Card, Field, Input } from "./ui";
import { cn } from "@/lib/utils";

/**
 * Images chosen because they stay up with no configuration. A preset that boots and
 * immediately exits (plain `alpine`, or `postgres` without credentials) would show a
 * crash loop and read as a bug in this app rather than in the image.
 */
const PRESETS = [
  { label: "Redis", image: "redis:7-alpine" },
  { label: "Nginx", image: "nginx:alpine" },
  { label: "whoami", image: "traefik/whoami" },
  { label: "Apache", image: "httpd:alpine" },
];

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
  const [result, formAction, pending] = useActionState<ActionResult | null, FormData>(
    spinUp,
    null,
  );
  const [image, setImage] = useState(PRESETS[0].image);
  // Uncontrolled: nothing else reads the name, and clearing it on success is then a
  // DOM write rather than a setState inside an effect.
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!result?.ok) return;
    if (nameRef.current) nameRef.current.value = "";
    router.refresh();
  }, [result, router]);

  return (
    <Card className="p-4">
      <form action={formAction} className="space-y-4">
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="environmentId" value={environmentId} />

        <div>
          <span className="mb-2 block text-sm font-medium">Image</span>
          <div className="mb-2 flex flex-wrap gap-2">
            {PRESETS.map((preset) => (
              <button
                key={preset.image}
                type="button"
                onClick={() => setImage(preset.image)}
                aria-pressed={image === preset.image}
                className={cn(
                  "focus-ring rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                  image === preset.image
                    ? "border-accent bg-accent/10 text-accent"
                    : "border-border text-muted hover:bg-subtle",
                )}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <Field
            label="Image reference"
            hint="Any public Docker image. Private registries are not supported yet."
            error={result && !result.ok && result.field === "image" ? result.error : undefined}
          >
            <Input
              name="image"
              value={image}
              onChange={(e) => setImage(e.target.value)}
              placeholder="redis:7-alpine"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              required
            />
          </Field>
        </div>

        <Field
          label="Name"
          hint="Prefixed automatically so this app can tell its own containers apart."
          error={result && !result.ok && result.field === "name" ? result.error : undefined}
        >
          <Input
            ref={nameRef}
            name="name"
            defaultValue=""
            placeholder="cache"
            autoComplete="off"
            required
          />
        </Field>

        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" disabled={pending || disabled}>
            <Plus aria-hidden className="size-4" />
            {pending ? "Spinning up…" : "Spin up container"}
          </Button>
          {disabled && (
            <span className="text-xs text-muted">
              Select a project and environment first.
            </span>
          )}
        </div>

        {result && !result.ok && !result.field && (
          <Banner tone="error">{result.error}</Banner>
        )}
        {result?.ok && <Banner tone="success">{result.message}</Banner>}
      </form>
    </Card>
  );
}
