"use client";

import { useEffect, useState } from "react";
import { ArrowUp } from "lucide-react";
import { useTranslations } from "next-intl";
import { LIST } from "@/lib/constants";
import { CONTAINER_HEADING_ID } from "./container-section-header";
import { Button } from "./ui/button";

/**
 * Returns a long dashboard to the top.
 *
 * The document is the scroller — <body> is a min-height flex column and <main> declares no
 * overflow — so this reads window.scrollY rather than plumbing a container ref through the
 * list. ScrollArea is confined to the log pane and is not involved.
 *
 * Gated on scroll depth alone rather than on how many rows are loaded: one expanded log
 * pane makes the page long enough to want this, and a page short enough not to want it
 * never crosses the threshold anyway.
 */
export function ScrollToTop() {
  const t = useTranslations("dashboard");
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      // Coalesced to one read per frame: scroll fires far faster than it can paint, and
      // scrollY is a layout read.
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setVisible(window.scrollY > LIST.SCROLL_TOP_AFTER_PX);
      });
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  if (!visible) return null;

  return (
    <Button
      variant="secondary"
      size="sm"
      aria-label={t("scrollToTop")}
      onClick={() => {
        /*
         * Reduced motion is checked here rather than left to CSS. globals.css neutralises
         * animations and transitions, but scrollTo's `behavior` is a JS argument that
         * overrides the CSS scroll-behavior property outright — so the one motion on this
         * page that the global rule cannot reach is exactly this one.
         */
        const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });

        // Focus follows the scroll. Otherwise focus stays on a control that is now off
        // screen, and the next Tab continues from somewhere invisible.
        document.getElementById(CONTAINER_HEADING_ID)?.focus({ preventScroll: true });
      }}
      /*
       * Bottom-LEFT. The toast viewport is fixed bottom-right, and a button parked there
       * would sit under every spin-up and destroy confirmation. The ordering that keeps
       * toasts above this when they do collide on a narrow viewport is `float` below
       * `overlay` — declared once in tokens.css rather than argued for here.
       */
      className="z-float fixed bottom-4 left-4 shadow-lg"
    >
      <ArrowUp aria-hidden />
    </Button>
  );
}
