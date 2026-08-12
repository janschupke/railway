import { getTranslations } from "next-intl/server";
import { LINKS } from "@/lib/constants";
import { Text } from "./ui/text";

/**
 * The app's one footer, rendered from the root layout so the landing page, the
 * dashboard and the 404 all get it without any of them opting in.
 *
 * A Server Component on purpose. It carries no state and no handlers, and the root
 * layout is the one place where a client component would add its bundle to every route
 * at once — the same reasoning that keeps ToastProvider down in the dashboard layout.
 *
 * Geometry mirrors DashboardHeader's bar (`max-w-4xl`, `px-6 py-3`, a border on the
 * facing edge) so the two read as one frame. That is deliberately wider than the
 * landing page's `max-w-md` card: the footer is app chrome, like the header, not part
 * of the page's content column.
 */
export async function Footer() {
  const t = await getTranslations("footer");

  return (
    <footer className="border-border bg-surface mt-auto border-t">
      <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-6 py-3">
        <Text variant="caption" tone="subtle">
          {t("apiNote")}
        </Text>

        <nav className="flex items-center gap-4">
          {/*
            Plain anchors, not Button asChild: these are navigation inside a
            contentinfo landmark, and dressing them as controls would announce two
            buttons in a footer that has no actions in it.
          */}
          <Text asChild variant="caption" tone="subtle">
            <a
              className="focus-ring link hover:text-text"
              href={LINKS.REPOSITORY}
              target="_blank"
              rel="noreferrer"
            >
              {t("source")}
            </a>
          </Text>
          <Text asChild variant="caption" tone="subtle">
            <a
              className="focus-ring link hover:text-text"
              href={LINKS.RAILWAY_HOME}
              target="_blank"
              rel="noreferrer"
            >
              {t("builtOn")}
            </a>
          </Text>
        </nav>
      </div>
    </footer>
  );
}
