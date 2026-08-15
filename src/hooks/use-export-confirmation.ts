"use client";

import { useEffect, useRef, useState } from "react";
import { UI } from "@/lib/constants";

/**
 * The tick that appears after an export, and the timer that takes it away again.
 *
 * One value rather than two booleans: the two ticks are mutually exclusive in practice, and
 * a single state cannot get stuck showing both.
 *
 * The timeout is held in a ref and cleared on unmount because the pane this serves is
 * mounted behind a row's `mounted` gate — collapsing the row mid-window would otherwise
 * leave a `setState` scheduled against a component that is gone.
 *
 * Lifted out of `log-pane.tsx`, where it was interleaved with the scroll code and shared
 * nothing with it. The two layout effects there deliberately did *not* come with it: their
 * order of declaration is what makes the search jump win against the autoscroll on a commit
 * where both could run, and splitting them into separate hooks would make that depend on
 * the order the caller happens to call them in.
 */
export function useExportConfirmation() {
  const [confirmed, setConfirmed] = useState<"copy" | "download" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const confirm = (which: "copy" | "download") => {
    setConfirmed(which);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setConfirmed(null), UI.ACTION_FEEDBACK_MS);
  };

  return { confirmed, confirm };
}
