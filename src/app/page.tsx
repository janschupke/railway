import { redirect } from "next/navigation";
import { Container, ShieldCheck } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { getSession } from "@/lib/auth/server";
import { SignInButton } from "@/components/sign-in-button";
import { Banner } from "@/components/ui/banner";
import { Card } from "@/components/ui/card";
import { ThemeToggle } from "@/components/ui/theme-toggle";

/*
 * The OAuth failure codes this app writes into `?error=`, plus the ones Railway passes
 * through. They are message *ids*, not copy — the wording lives in the catalog under
 * `signIn.<code>`, and an unrecognised code falls back to `signIn.failed`.
 */
const SIGN_IN_ERRORS = [
  "session_expired",
  "no_refresh_token",
  "token_exchange_failed",
  "missing_pkce_state",
  "missing_id_token",
  "access_denied",
] as const;

type SignInError = (typeof SIGN_IN_ERRORS)[number];

const isKnownError = (value: string): value is SignInError =>
  SIGN_IN_ERRORS.includes(value as SignInError);

export default async function LandingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await getSession()) redirect("/dashboard");

  const t = await getTranslations();
  const { error } = await searchParams;
  const message = error
    ? t(isKnownError(error) ? `signIn.${error}` : "signIn.failed")
    : null;

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 p-6">
      <div className="flex justify-end">
        <ThemeToggle />
      </div>

      <div className="space-y-3">
        <span className="bg-accent-bg text-accent inline-flex size-10 items-center justify-center rounded-lg">
          <Container aria-hidden className="size-5" />
        </span>
        <h1 className="font-display text-text text-2xl font-semibold tracking-tight">
          {t("app.name")}
        </h1>
        <p className="text-text-muted text-sm">{t("landing.intro")}</p>
      </div>

      {message && <Banner tone="error">{message}</Banner>}

      <Card className="space-y-4 p-5">
        <SignInButton variant="primary" size="lg" className="w-full" />
        <p className="text-text-subtle flex items-start gap-2 text-xs">
          <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>{t("landing.consentNote")}</span>
        </p>
      </Card>
    </main>
  );
}
