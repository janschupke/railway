"use client";

import { useTranslations } from "next-intl";
import { useNavigationPending } from "@/hooks/use-navigation-pending";
import { Button } from "./ui/button";

type SignInButtonProps = Omit<
  React.ComponentProps<typeof Button>,
  "children" | "asChild" | "pending" | "pendingLabel"
> & {
  label?: string;
  /**
   * Force Railway's consent screen.
   *
   * For "choose projects" and "authorize again", where re-picking the shared projects is
   * the entire point of the click. Plain sign-in leaves the decision to Railway, which
   * skips the screen once the grant exists — that is what stops this app asking for
   * authorization over and over.
   */
  consent?: boolean;
};

/**
 * Sign-in stays a plain link, so it works before hydration. The only thing this wrapper
 * adds is feedback: /api/auth/login generates a PKCE challenge, writes cookies and
 * redirects to Railway — slow enough that a bare anchor reads as a dead click.
 */
export function SignInButton({ label, consent, ...buttonProps }: SignInButtonProps) {
  const t = useTranslations("common");
  const { pending, start } = useNavigationPending();

  return (
    <Button asChild pending={pending} {...buttonProps}>
      {/* The label is swapped here rather than via `pendingLabel`, which cannot reach
          inside a slotted element. */}
      <a
        href={consent ? "/api/auth/login?consent=1" : "/api/auth/login"}
        onClick={start}
      >
        {pending ? t("signInPending") : (label ?? t("signIn"))}
      </a>
    </Button>
  );
}
