"use client";

import { useEffect } from "react";
import { Button, Card } from "@/components/ui";

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
        <h1 className="font-medium">The dashboard could not load</h1>
        <p className="text-sm text-muted">
          This is usually a Railway API hiccup or an expired authorization. Retrying is
          safe — nothing was created or destroyed.
        </p>
        <div className="flex gap-2">
          <Button variant="primary" onClick={reset}>
            Retry
          </Button>
          <a
            href="/api/auth/login"
            className="focus-ring inline-flex items-center rounded-md border border-border px-3 py-1.5 text-sm hover:bg-subtle"
          >
            Re-authorize
          </a>
        </div>
        {error.digest && (
          <p className="font-mono text-xs text-muted">ref: {error.digest}</p>
        )}
      </Card>
    </main>
  );
}
