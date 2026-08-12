"use client";

import { useTranslations } from "next-intl";
import { useNavigationPending } from "@/hooks/use-navigation-pending";
import { Button } from "./ui/button";

type SignInButtonProps = Omit<
  React.ComponentProps<typeof Button>,
  "children" | "asChild" | "pending" | "pendingLabel"
> & { label?: string };

/**
 * Sign-in stays a plain link, so it works before hydration. The only thing this wrapper
 * adds is feedback: /api/auth/login generates a PKCE challenge, writes cookies and
 * redirects to Railway — slow enough that a bare anchor reads as a dead click.
 */
export function SignInButton({ label, ...buttonProps }: SignInButtonProps) {
  const t = useTranslations("common");
  const { pending, start } = useNavigationPending();

  return (
    <Button asChild pending={pending} {...buttonProps}>
      {/* The label is swapped here rather than via `pendingLabel`, which cannot reach
          inside a slotted element. */}
      <a href="/api/auth/login" onClick={start}>
        {pending ? t("signInPending") : (label ?? t("signIn"))}
      </a>
    </Button>
  );
}
