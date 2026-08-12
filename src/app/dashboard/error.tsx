"use client";

import { useEffect, useTransition } from "react";
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
  const [retrying, startTransition] = useTransition();

  useEffect(() => {
    // Server-side detail is redacted in production builds; the digest is the join key.
    console.error("dashboard error", error.digest ?? error.message);
  }, [error]);

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 items-center p-6">
      <Card className="w-full space-y-3 p-6">
        <h1 className="font-display text-text font-medium">
          The dashboard could not load
        </h1>
        <p className="text-text-muted text-sm">
          This is usually a Railway API hiccup or an expired authorization. Retrying is
          safe — nothing was created or destroyed.
        </p>
        <div className="flex gap-2">
          {/*
            reset() re-renders the boundary, which re-runs the server fetch that failed.
            Wrapping it in a transition is what makes that wait observable.
          */}
          <Button
            variant="primary"
            onClick={() => startTransition(() => reset())}
            pending={retrying}
            pendingLabel="Retrying…"
          >
            Retry
          </Button>
          <SignInButton label="Re-authorize" variant="secondary" />
        </div>
        {error.digest && (
          <p className="text-text-subtle font-mono text-xs">ref: {error.digest}</p>
        )}
      </Card>
    </main>
  );
}
