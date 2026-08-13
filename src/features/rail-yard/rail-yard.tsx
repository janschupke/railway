"use client";

import { useRef } from "react";
import { cn } from "@/lib/utils";
import { useRailYard } from "./use-rail-yard";

/**
 * The freight yard behind the sign-in card.
 *
 * `aria-hidden` and nothing else: no role, no label, no text alternative. The page's
 * meaning is entirely in the card in front of this, so a `role="img"` with a translated
 * description would put a wordless animation into the accessibility tree and hand a
 * screen-reader user a sentence to skip past on every visit. This is presentation, and
 * aria-hidden is how you say so.
 *
 * `absolute` is load-bearing rather than cosmetic. It keeps the canvas out of layout
 * entirely, so its intrinsic 300×150 never participates and resizing the bitmap can
 * never move anything — which is how a full-page animation on the landing route
 * contributes nothing at all to cumulative layout shift.
 */
export function RailYard({ className }: { className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useRailYard(canvas);

  return (
    <canvas
      ref={canvas}
      aria-hidden
      className={cn("pointer-events-none absolute inset-0 size-full", className)}
    />
  );
}
