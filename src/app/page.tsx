import { redirect } from "next/navigation";
import { Container, ShieldCheck } from "lucide-react";
import { getSession } from "@/lib/auth/server";
import { SignInButton } from "@/components/sign-in-button";
import { Banner } from "@/components/ui/banner";
import { Card } from "@/components/ui/card";
import { ThemeToggle } from "@/components/ui/theme-toggle";

const ERRORS: Record<string, string> = {
  session_expired:
    "Your Railway session expired and could not be renewed. Sign in again.",
  no_refresh_token:
    "Railway did not return a refresh token, so the session would expire in an hour. Sign in again and approve offline access when prompted.",
  token_exchange_failed:
    "Railway rejected the sign-in. Check that this app's redirect URI matches the one registered on the OAuth app.",
  missing_pkce_state:
    "The sign-in attempt timed out or the cookies were cleared. Start again.",
  missing_id_token: "Railway did not return an identity token. Try again.",
  access_denied: "You declined the authorization request.",
};

export default async function LandingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await getSession()) redirect("/dashboard");

  const { error } = await searchParams;
  const message = error ? (ERRORS[error] ?? "Sign-in failed. Try again.") : null;

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
          Container Console
        </h1>
        <p className="text-text-muted text-sm">
          Spin containers up and down in your own Railway projects. Sign in with Railway
          and pick which projects this app may touch.
        </p>
      </div>

      {message && <Banner tone="error">{message}</Banner>}

      <Card className="space-y-4 p-5">
        <SignInButton variant="primary" size="lg" className="w-full" />
        <p className="text-text-subtle flex items-start gap-2 text-xs">
          <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            Railway&rsquo;s consent screen lets you choose exactly which projects to
            share. This app can only destroy containers it created itself.
          </span>
        </p>
      </Card>
    </main>
  );
}
