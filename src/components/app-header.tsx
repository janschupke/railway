import Link from "next/link";
import { Container } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { SignOutButton } from "./sign-out-button";
import { Text } from "./ui/text";
import { ThemeToggle } from "./ui/theme-toggle";

/**
 * The one top bar, rendered from the root layout so every route gets it.
 *
 * It used to be a dashboard component, which left the landing page with a theme toggle
 * floating on bare canvas, the dashboard's error boundary with no bar at all, and the
 * 404 with neither. Three copies of the same markup existed — this one, the loading
 * skeleton's, and nothing on the routes that needed it most.
 *
 * The bar's contents are a function of *session presence*, not of route, which is what
 * makes a single render site possible: `/` redirects to `/dashboard` when a session
 * exists, and the proxy redirects `/dashboard` to `/` when one does not, so a signed-in
 * bar never paints on the landing page or the reverse. The 404 gets whichever is right
 * for free.
 */
export async function AppHeader({
  user,
}: {
  /** The signed-in user, or null on the landing page and on a 404 while signed out. */
  user: { name?: string; email?: string } | null;
}) {
  const t = await getTranslations();

  /*
   * The identity is dropped entirely when Railway returns neither a name nor an email,
   * rather than falling back to the words "Signed in". That label told the user
   * something the presence of a Sign out button already says, and it occupied the slot
   * where their name belongs — so an account with no profile looked like it had one.
   *
   * Note `user: {}` and `user: null` are different: the first is signed in with no
   * profile and still gets a Sign out button, the second is not signed in at all.
   */
  const identity = user ? (user.name ?? user.email) : undefined;

  return (
    /*
     * A <header>, not a <nav>. The footer already has an unnamed navigation landmark,
     * and a second one would be ambiguous to a screen-reader's landmark list — one link
     * in a bar of controls does not earn one.
     *
     * The brand is that link. It costs a focus stop ahead of the theme toggle, which is
     * worth paying: the routes that most need a way out — the 404 and the dashboard's
     * error boundary — are exactly the ones where the top-left mark is the only thing a
     * visitor already knows how to click. `/` is the right target signed in or out,
     * because the landing page redirects to the dashboard when a session exists and the
     * proxy sends the dashboard back here when one does not.
     *
     * `focus-ring` but not `link`: an underline on hover would make the wordmark read as
     * body copy rather than as the app's mark.
     *
     * `next/link`, unlike every other anchor here, because those all point off-site. This
     * one is an internal route, and a plain <a> would throw away the whole client render
     * to move between two pages of the same app. It is not prefetched, though: `/`
     * redirects for a signed-in visitor, so prefetching it buys a discarded render of a
     * page nobody will see.
     */
    <header className="border-border bg-surface border-b">
      <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-4 px-6 py-3">
        <Link
          href="/"
          prefetch={false}
          className="focus-ring flex items-center gap-2 rounded-sm"
        >
          <Container aria-hidden className="text-accent size-4" />
          <Text variant="title">{t("app.name")}</Text>
        </Link>

        <div className="flex items-center gap-3">
          {/*
            Matched to the Sign out button's own label size. These two sit side by side,
            so a name at a different step read as a mistake — which it was: neither had
            chosen a size, they had each reached for a different Tailwind step. The step
            is `body` because that is what every control label is now, at every height:
            a button that shrinks its text along with its box reads as a different kind
            of control, so the text no longer moves and the name follows it.
          */}
          {identity && (
            <Text variant="body" tone="muted" className="hidden sm:inline">
              {identity}
            </Text>
          )}
          <ThemeToggle />
          {user && <SignOutButton />}
        </div>
      </div>
    </header>
  );
}
