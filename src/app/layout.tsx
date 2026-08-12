import type { Metadata } from "next";
import { Inter, Inter_Tight } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { Footer } from "@/components/footer";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const interTight = Inter_Tight({
  variable: "--font-inter-tight",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
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
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_THEME }} />
        {/*
          ToastProvider deliberately lives in the dashboard layout, not here: it is the
          only subtree that raises toasts, and mounting Radix Toast globally cost the
          landing page and the 404 ~12 kB gzip they could never use.
        */}
        <NextIntlClientProvider>
          {children}
          {/*
            Outside {children} so every route gets it — including the 404, which has no
            file of its own. <body> is already a min-height flex column and every page's
            <main> carries flex-1, so this sits at the bottom of a short page without
            any layout change. It stays a Server Component: anything client-side here
            would ship on every route at once.
          */}
          <Footer />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
