"use client";

import { useEffect, useState } from "react";

/**
 * A promise a server render handed down, read without suspending on it.
 *
 * The point of taking a promise at all rather than a value: `use()` would suspend the
 * component until the read arrived, and the whole reason the page passes these unawaited is
 * that the form has to paint before them. So this resolves in an effect and the value shows
 * up a moment later — which is correct for both callers, because both are checks and choices
 * a form is usable without.
 *
 * A fresh promise arrives on every render of the page, which is how each value learns about
 * what the last submission did. The `live` flag is the ordering that follows from that: a
 * slow earlier read must not land on top of a newer one, and an unmounted component must not
 * be written to at all.
 *
 * One hazard, and it is ADR-7's named one in its other form. Nothing else may go in this
 * dependency array. `promise` is a stable identity for as long as the render that made it,
 * and a value derived per render — a translator function, an inline object — would re-run
 * this on every render forever. That is the loop that fired the spin-up form's success toast
 * dozens of times; see the note on `failedTitle` in spin-up-form.tsx.
 */
export function useResolved<T>(promise: Promise<T>, initial: T): T {
  const [value, setValue] = useState<T>(initial);

  useEffect(() => {
    let live = true;
    void promise.then((resolved) => {
      if (live) setValue(resolved);
    });
    return () => {
      live = false;
    };
  }, [promise]);

  return value;
}
