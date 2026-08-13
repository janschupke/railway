"use client";

import { useEffect, useTransition } from "react";
import { useTranslations } from "next-intl";
import { SignInButton } from "@/components/sign-in-button";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ErrorBlock } from "@/components/ui/error-block";
import { Heading, Text } from "@/components/ui/text";
import { PageMain } from "@/components/ui/page";

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
    /*
     * The one sanctioned console call in src/. This runs in the browser, where the
     * server's stdout logger has no meaning and no sink; server-side detail is redacted
     * in production builds anyway. The digest is the join key — the same digest that
     * `render.failed` records from src/instrumentation.ts, which is where the cause
     * actually is.
     */
    // eslint-disable-next-line no-console -- browser console; see above.
    console.error("dashboard error", error.digest ?? error.message);
  }, [error]);

  return (
    /*
     * The dashboard's own column width, not a narrower one. This replaces the dashboard's
     * content, and the header above it is unchanged — so snapping from 56rem to 28rem
     * read as landing on a different page rather than as one page reporting a failure.
     */
    <PageMain layout="centre">
      <Card className="w-full space-y-3 p-6">
        {/* A page's only heading, at the same rank and role as the landing page's.
            It used to render at body size in a lighter weight than any other h1. */}
        <Heading level={1} variant="title">
          {t("errorTitle")}
        </Heading>
        {/*
          The same block the in-page failure uses, so the two error surfaces stop
          disagreeing: Retry used to be primary here and secondary there, and neither
          sat inside the thing that had failed.

          reset() re-renders the boundary, which re-runs the server fetch that failed.
          Wrapping it in a transition is what makes that wait observable.
        */}
        <ErrorBlock
          message={t("errorDescription")}
          actions={
            <>
              <Button
                variant="danger"
                onClick={() => startTransition(() => reset())}
                pending={retrying}
                pendingLabel={t("retryPending")}
              >
                {tCommon("retry")}
              </Button>
              <SignInButton label={t("reauthorize")} consent variant="danger" />
            </>
          }
        />
        {error.digest && (
          <Text asChild variant="mono" tone="subtle">
            <p>{t("errorRef", { digest: error.digest })}</p>
          </Text>
        )}
      </Card>
    </PageMain>
  );
}
