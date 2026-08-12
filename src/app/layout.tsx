import type { Metadata } from "next";
import { Inter, Inter_Tight } from "next/font/google";
import { ToastProvider } from "@/components/ui/toast";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const interTight = Inter_Tight({
  variable: "--font-inter-tight",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Container Console",
  description: "Spin containers up and down on Railway.",
};

/**
 * Applies the stored theme before first paint. Without this the page renders at the OS
 * preference and then snaps to the stored choice — a visible flash on every load.
 */
const NO_FLASH_THEME = `(function(){try{var t=localStorage.getItem("theme");if(t==="light"||t==="dark"){document.documentElement.dataset.theme=t}}catch(e){}})()`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
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
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
