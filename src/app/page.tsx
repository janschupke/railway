import { redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { getSession } from "@/lib/auth/server";
import { managedPrefix } from "@/lib/railway/managed";
import { RailYard } from "@/features/rail-yard/rail-yard";
import { SignInButton } from "@/components/sign-in-button";
import { Banner } from "@/components/ui/banner";
import { Card } from "@/components/ui/card";
import { Heading, Text } from "@/components/ui/text";
import { PageMain } from "@/components/ui/page";

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
     * A full-height stage the width of the bars above and below, with the freight yard
     * running behind the card.
     *
     * The <main> is wide and the card is not. That split is the point: the page used to
     * be a 28rem column between two 56rem bars, which read as three unrelated blocks
     * rather than as one page, while a sign-in form actually stretched to 56rem reads as
     * an empty page. Widening the region and keeping the reading column narrow is what
     * lines the page up with its own chrome without touching the form.
     */
    <PageMain width="wide" layout="stage" pad="none">
      <RailYard />

      {/*
        `relative` puts this in front of the absolutely-positioned canvas without
        reaching for a z-index token: both elements are positioned, so DOM order decides,
        and DOM order is already the painting order.

        The error banner belongs inside this column rather than above the stage. Out
        there it would push the card down off centre; in here the group re-centres around
        it, which is also why the canvas cannot contribute to layout shift.
      */}
      <div className="relative w-full max-w-md space-y-4 p-6">
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
              {/*
                The note names the mechanism rather than promising more than it can keep.
                Ownership is the service-name prefix and nothing else — see ADR-5 — so a
                flat "only destroys what it created" would overstate it. The prefix is
                interpolated because it is configurable, and rich text rather than
                concatenation so the <code> span can move when the sentence is
                translated; the dashboard's prefixNote does the same thing.
              */}
              <span>
                {t.rich("landing.consentNote", {
                  prefix: managedPrefix(),
                  code: (chunks) => <code className="font-mono">{chunks}</code>,
                })}
              </span>
            </p>
          </Text>
        </Card>
      </div>
    </PageMain>
  );
}
