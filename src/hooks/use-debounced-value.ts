"use client";

import { useEffect, useState } from "react";

/**
 * The value, settled.
 *
 * Returns `value` unchanged once it has held still for `delayMs`; every change before
 * that cancels the pending settle. The first render is not delayed — a deep-linked
 * `?q=redis` filters on the very first paint rather than a quarter-second later, because
 * the initial state is the initial value and the timer that follows sets it to itself.
 *
 * The cleanup clears the timer, so a component unmounted mid-type never sets state.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
}
