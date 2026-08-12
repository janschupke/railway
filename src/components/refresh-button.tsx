"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "./ui/button";

/**
 * Re-runs the server render, and with it the Railway read.
 *
 * The dashboard is `force-dynamic`, so `router.refresh()` genuinely re-queries rather
 * than replaying a cache. This is the honest primary action for an empty project list:
 * the app cannot tell a transient empty response from a permanent one, and asking
 * Railway again is both cheaper and likelier to help than sending the user back through
 * a consent screen that already granted everything.
 *
 * Wrapping refresh in a transition is what makes the wait observable — without it the
 * button reports done while the server is still fetching.
 */
export function RefreshButton({
  label,
  pendingLabel,
  ...buttonProps
}: Omit<
  React.ComponentProps<typeof Button>,
  "children" | "onClick" | "pending" | "pendingLabel"
> & {
  label: string;
  pendingLabel: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      onClick={() => startTransition(() => router.refresh())}
      pending={pending}
      pendingLabel={pendingLabel}
      {...buttonProps}
    >
      {label}
    </Button>
  );
}
