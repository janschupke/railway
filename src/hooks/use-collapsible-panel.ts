"use client";

import { useEffect, useId, useRef, useState } from "react";
import { UI } from "@/lib/constants";

/**
 * A region that opens and closes with a height transition, and stays out of the tab order
 * while it is shut.
 *
 * Two pieces of state rather than one, and that is the whole of it. `expanded` is the
 * user's intent and drives `aria-expanded` and the grid rows; `mounted` is whether there is
 * still something on screen to collapse. They differ because `hidden` is `display: none`
 * and nothing can be transitioned out of that — while it is also the only thing keeping a
 * collapsed panel out of the tab order and the accessibility tree, so it cannot simply be
 * dropped.
 *
 * Returned as prop bundles rather than as raw state because the pieces are only correct
 * together: the two-frame open, the intent guard and the backstop below each exist to
 * defeat a specific way the pair can be left disagreeing, and a caller assembling them by
 * hand is a caller that can reintroduce one.
 *
 * Lifted out of `container-row.tsx`, where it was fifty lines that referenced nothing about
 * containers.
 */
export function useCollapsiblePanel() {
  const [expanded, setExpanded] = useState(false);
  const [mounted, setMounted] = useState(false);
  const panelId = useId();

  /*
   * Which way the panel is currently travelling.
   *
   * `mounted && !expanded` is TWO different states — one frame into opening, and one
   * transition away from closed — and without this ref the backstop below could not tell
   * them apart. It assumed closing, so a machine that delayed the frames past the timer
   * ran `setMounted(false)` on a panel that was opening; the rAF then set `expanded`
   * true against an unmounted panel and the row stuck there, `aria-expanded="true"` over
   * a `hidden` region with no way back short of a reload. A ref rather than state
   * because it must be readable inside the frame callback without re-running it.
   */
  const intent = useRef<"open" | "closed">("closed");

  const toggle = () => {
    if (expanded) {
      intent.current = "closed";
      setExpanded(false);
      return;
    }
    intent.current = "open";
    setMounted(true);
    /*
     * Two frames, not one. The first commits `mounted` — `hidden` comes off at
     * grid-rows 0fr — and the second flips to 1fr with a start value the transition can
     * interpolate from. Collapsing needs no equivalent: the panel is already laid out.
     */
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        // A close that landed while these frames were queued wins; opening now would
        // re-expand a panel the user has already dismissed.
        if (intent.current === "open") setExpanded(true);
      }),
    );
  };

  /*
   * Backstop for an interrupted transition. Toggling faster than the animation means
   * `transitionend` may never fire, which would leave a zero-height panel mounted and
   * therefore in the tab order — invisible, and focusable.
   */
  useEffect(() => {
    if (expanded || !mounted || intent.current === "open") return;
    const timer = setTimeout(() => setMounted(false), UI.TRANSITION_BACKSTOP_MS);
    return () => clearTimeout(timer);
  }, [expanded, mounted]);

  return {
    expanded,
    /** Whether the panel's contents should be rendered at all. */
    mounted,
    toggle,
    /** For the control that opens it. */
    triggerProps: {
      "aria-expanded": expanded,
      "aria-controls": panelId,
      onClick: toggle,
    },
    /**
     * For the panel element itself.
     *
     * Always rendered, toggled with `hidden`: `aria-controls` must point at an element that
     * exists in both states, and a collapsed panel that is not in the DOM has no node to
     * point at.
     */
    panelProps: {
      id: panelId,
      hidden: !mounted,
      "data-panel-open": expanded,
      onTransitionEnd: (event: { propertyName: string }) => {
        if (event.propertyName === "grid-template-rows" && !expanded) {
          setMounted(false);
        }
      },
    },
  };
}
