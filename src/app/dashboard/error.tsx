"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
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
          <Button variant="primary" onClick={reset}>
            Retry
          </Button>
          <Button asChild variant="secondary">
            <a href="/api/auth/login">Re-authorize</a>
          </Button>
        </div>
        {error.digest && (
          <p className="text-text-subtle font-mono text-xs">ref: {error.digest}</p>
        )}
      </Card>
    </main>
  );
}
