"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Pending state for controls that hand the page to the browser.
 *
 * Sign-in, sign-out and re-authorization are full document navigations to route
 * handlers, not React transitions — `useTransition` and `useFormStatus` see nothing, so
 * the flag has to be raised from the activation event itself.
 *
 * The `pageshow` listener is the part worth keeping: coming back via bfcache (browser
 * Back after declining Railway's consent screen) restores the DOM exactly as it was
 * left, spinner and all. Without the reset the button spins forever on a page that is
 * no longer doing anything.
 */
export function useNavigationPending() {
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const reset = () => setPending(false);
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);

  const start = useCallback(() => setPending(true), []);

  return { pending, start };
}
