import { getTranslations } from "next-intl/server";
import { getSession } from "@/lib/auth/server";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Heading, Text } from "@/components/ui/text";

/**
 * The 404, which until now was Next's built-in one.
 *
 * That default renders a bare inline-styled `<h1>404</h1>` inside the root layout — no
 * `<main>`, no width constraint and no `flex-1`, so the footer's `mt-auto` was the only
 * thing positioning it and the page had no landmark to skip to. This gives the route the
 * same column, heading rank and card the dashboard's error boundary uses.
 *
 * Only `<main>` is rendered here: the bar and the footer come from the root layout, which
 * is the whole point of moving them there.
 */
export default async function NotFound() {
  const t = await getTranslations("notFound");

  /*
   * `/` redirects to `/dashboard` when a session exists, so a single unconditional link
   * would take everyone to the right place regardless. The session is read for the
   * *label*: telling a signed-in user to go back to the sign-in page is the kind of
   * small dishonesty that makes an app feel broken.
   */
  const signedIn = Boolean(await getSession());

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 items-center p-6">
      <Card className="w-full space-y-3 p-6">
        <Heading level={1} variant="title">
          {t("title")}
        </Heading>
        <Text asChild variant="body" tone="muted">
          <p>{t("description")}</p>
        </Text>
        <Button asChild variant="primary" size="sm">
          <a href={signedIn ? "/dashboard" : "/"}>
            {signedIn ? t("backToDashboard") : t("backToStart")}
          </a>
        </Button>
      </Card>
    </main>
  );
}
