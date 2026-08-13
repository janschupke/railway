import type { Metadata } from "next";
import { headers } from "next/headers";
import localFont from "next/font/local";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { getSession } from "@/lib/auth/server";
import { AppHeader } from "@/components/app-header";
import { Footer } from "@/components/footer";
import { SkipLink } from "@/components/ui/page";
import "./globals.css";

/**
 * The two faces, self-hosted from files in the repository.
 *
 * `next/font/google` downloads these at **build time**, which makes every build depend on
 * reaching fonts.gstatic.com — and when that call fails there is no graceful degradation:
 * Turbopack emits the `@font-face` rules and then cannot resolve the files they name, so the
 * build ends with one "Module not found" per unicode range. That is what CI hit, twenty-one
 * times in one run, on a build that is otherwise entirely self-contained: the tests run
 * against a fake Railway, the yard is seeded rather than clocked, and nothing else in this
 * repository asks the network for permission to compile.
 *
 * Serving is unchanged. `next/font/google` was already emitting these same files under
 * /_next/static/media — see the CSP note in lib/security-headers.ts — so this moves *when*
 * they are fetched, not where they come from. The two files are the `latin` subsets of the
 * variable faces, which is what was being preloaded before and all this app's own text needs;
 * a Cyrillic container name coming back from Railway now falls back to a system face rather
 * than pulling a subset nobody had preloaded anyway.
 *
 * `100 900` is the variable weight axis both files carry. Declaring the range rather than a
 * list is what lets the 500/600/700 the type scale asks for come out of one file.
 */
const inter = localFont({
  src: "./fonts/inter-latin.woff2",
  variable: "--font-inter",
  weight: "100 900",
  display: "swap",
});
const interTight = localFont({
  src: "./fonts/inter-tight-latin.woff2",
  variable: "--font-inter-tight",
  weight: "100 900",
  display: "swap",
});

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("app");
  return { title: t("name"), description: t("description") };
}

/**
 * Applies the stored theme before first paint. Without this the page renders at the OS
 * preference and then snaps to the stored choice — a visible flash on every load.
 */
const NO_FLASH_THEME = `(function(){try{var t=localStorage.getItem("theme");if(t==="light"||t==="dark"){document.documentElement.dataset.theme=t}}catch(e){}})()`;

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const locale = await getLocale();
  const t = await getTranslations("common");
  /*
   * Minted per request in src/proxy.ts. Next stamps its own injected scripts from the
   * request's CSP header automatically; an author-written dangerouslySetInnerHTML
   * script is not covered by that, so this one carries the nonce explicitly or the
   * theme never applies and every load flashes.
   */
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  /*
   * Read here rather than in AppHeader so the component stays a pure function of its
   * props — the same reason the ESLint boundary rule keeps lib/auth out of
   * src/components. One extra JWE open per render: local crypto, no network, and the
   * cookie read is request-cached.
   */
  const session = await getSession();

  return (
    <html
      lang={locale}
      className={`${inter.variable} ${interTight.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="flex min-h-full flex-col">
        {/*
          First child of <body>, not <head>: the App Router hoists and re-orders
          scripts placed in <head>, which desynchronises hydration badly enough that
          React discards the server tree and renders a second copy alongside it.
        */}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: NO_FLASH_THEME }} />
        {/*
          The first focusable thing on every page.

          Without it a keyboard user pays five or six stops — the brand link, three theme
          radios, sign out — before reaching the content, on every navigation. Axe does
          not report it: its `bypass` rule is satisfied by the presence of a <main>
          landmark, and Lighthouse does not look at all, so all three gates were silent
          on this.

          A plain anchor, in the Server Component: no JS, and it works on the very first
          paint rather than after hydration, which is when a keyboard user is most likely
          to be pressing Tab.
        */}
        <SkipLink label={t("skipToContent")} />
        {/*
          ToastProvider deliberately lives in the dashboard layout, not here: it is the
          only subtree that raises toasts, and mounting Radix Toast globally cost the
          landing page and the 404 ~12 kB gzip they could never use.
        */}
        <NextIntlClientProvider>
          {/*
            Both bars live here rather than in the pages, so a route declares only its
            own content column. Inside the provider because ThemeToggle and
            SignOutButton both call useTranslations.
          */}
          <AppHeader
            user={
              session ? { name: session.user.name, email: session.user.email } : null
            }
          />
          {children}
          {/*
            <body> is already a min-height flex column and every page's <main> carries
            flex-1, so this sits at the bottom of a short page without any layout change.
            It stays a Server Component: anything client-side here would ship on every
            route at once.
          */}
          <Footer />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
