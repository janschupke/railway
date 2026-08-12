import { Container } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { SignOutButton } from "./sign-out-button";
import { Text } from "./ui/text";
import { ThemeToggle } from "./ui/theme-toggle";

export async function DashboardHeader({
  name,
  email,
}: {
  name?: string;
  email?: string;
}) {
  const t = await getTranslations();

  /*
   * The identity is dropped entirely when Railway returns neither a name nor an email,
   * rather than falling back to the words "Signed in". That label told the user
   * something the presence of a Sign out button already says, and it occupied the slot
   * where their name belongs — so an account with no profile looked like it had one.
   */
  const identity = name ?? email;

  return (
    <header className="border-border bg-surface border-b">
      <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-4 px-6 py-3">
        <span className="flex items-center gap-2">
          <Container aria-hidden className="text-accent size-4" />
          <Text variant="title">{t("app.name")}</Text>
        </span>

        <div className="flex items-center gap-3">
          {/*
            The caption variant, matching the Sign out button's own label size. These two
            sit side by side, so a body-sized name beside a caption-sized button read as
            a mistake — which it was: neither had chosen a size, they had each reached
            for a different Tailwind step.
          */}
          {identity && (
            <Text variant="caption" tone="muted" className="hidden sm:inline">
              {identity}
            </Text>
          )}
          <ThemeToggle />
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}
