import { redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { getSession } from "@/lib/auth/server";
import { SignInButton } from "@/components/sign-in-button";
import { Banner } from "@/components/ui/banner";
import { Card } from "@/components/ui/card";
import { Heading, Text } from "@/components/ui/text";

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
    /*
     * The column stays narrow while the bars above and below run the full width — a
     * sign-in form stretched to 56rem reads as an empty page. The theme toggle used to
     * float here in a bare right-aligned div because there was no bar to put it in;
     * it lives in the app header now, and the hero has moved into the card so the page
     * is one object instead of three blocks adrift on the canvas.
     */
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-4 p-6">
      {message && <Banner tone="error">{message}</Banner>}

      <Card className="space-y-4 p-6">
        {/* The mark is in the header two inches above; repeating it here was noise. */}
        <Heading level={1} variant="display">
          {t("app.name")}
        </Heading>
        <Text asChild variant="body" tone="muted">
          <p>{t("landing.intro")}</p>
        </Text>

        <SignInButton variant="primary" size="lg" className="w-full" />

        <Text asChild variant="caption" tone="subtle">
          <p className="flex items-start gap-2">
            <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>{t("landing.consentNote")}</span>
          </p>
        </Text>
      </Card>
    </main>
  );
}
