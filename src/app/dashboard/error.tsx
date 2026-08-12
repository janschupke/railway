"use client";

import { useEffect, useTransition } from "react";
import { useTranslations } from "next-intl";
import { SignInButton } from "@/components/sign-in-button";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Heading, Text } from "@/components/ui/text";

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
        {/* A page's only heading, at the same rank and role as the landing page's.
            It used to render at body size in a lighter weight than any other h1. */}
        <Heading level={1} variant="title">
          {t("errorTitle")}
        </Heading>
        <Text asChild variant="body" tone="muted">
          <p>{t("errorDescription")}</p>
        </Text>
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
          <Text asChild variant="mono" tone="subtle">
            <p>{t("errorRef", { digest: error.digest })}</p>
          </Text>
        )}
      </Card>
    </main>
  );
}
