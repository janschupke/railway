"use client";

import { useTranslations } from "next-intl";
import { useNavigationPending } from "@/hooks/use-navigation-pending";
import { Button } from "./ui/button";

/**
 * A native form POST, so sign-out survives a failed hydration. `useFormStatus` reports
 * nothing here — it only tracks React action submissions — hence the explicit flag.
 *
 * Disabling in the submit handler is safe: the browser has already committed to the
 * navigation by the time React re-renders, so this blocks the second click without
 * cancelling the first.
 */
export function SignOutButton() {
  const t = useTranslations("common");
  const { pending, start } = useNavigationPending();

  return (
    <form action="/api/auth/logout" method="post" onSubmit={start}>
      <Button
        type="submit"
        variant="ghost"
        size="sm"
        pending={pending}
        pendingLabel={t("signOutPending")}
      >
        {t("signOut")}
      </Button>
    </form>
  );
}
