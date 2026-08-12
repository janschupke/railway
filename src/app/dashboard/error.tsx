"use client";

import { useEffect, useTransition } from "react";
import { useTranslations } from "next-intl";
import { SignInButton } from "@/components/sign-in-button";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("dashboard");
  const tCommon = useTranslations("common");
  const [retrying, startTransition] = useTransition();

  useEffect(() => {
    // Server-side detail is redacted in production builds; the digest is the join key.
    console.error("dashboard error", error.digest ?? error.message);
  }, [error]);

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 items-center p-6">
      <Card className="w-full space-y-3 p-6">
        <h1 className="font-display text-text font-medium">{t("errorTitle")}</h1>
        <p className="text-text-muted text-sm">{t("errorDescription")}</p>
        <div className="flex gap-2">
          {/*
            reset() re-renders the boundary, which re-runs the server fetch that failed.
            Wrapping it in a transition is what makes that wait observable.
          */}
          <Button
            variant="primary"
            onClick={() => startTransition(() => reset())}
            pending={retrying}
            pendingLabel={t("retryPending")}
          >
            {tCommon("retry")}
          </Button>
          <SignInButton label={t("reauthorize")} variant="secondary" />
        </div>
        {error.digest && (
          <p className="text-text-subtle font-mono text-xs">
            {t("errorRef", { digest: error.digest })}
          </p>
        )}
      </Card>
    </main>
  );
}
