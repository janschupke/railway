/**
 * Random identifiers, minted from the platform CSPRNG.
 *
 * Deliberately import-free, and deliberately not `server-only`: the spin-up form mints
 * its own idempotency key in the browser, and `crypto.getRandomValues` is the one API
 * that exists unchanged on both sides. Anything with an import here would pull that
 * import into the /dashboard bundle along with it.
 */

/** Hex, two characters per byte. */
export function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Names one submission of the spin-up form, so a repeat of it can be recognised.
 *
 * 128 bits, because this is the only thing standing between a double-submit and a
 * duplicate container: a guessed or colliding key would replay someone's result instead
 * of creating what they asked for. Deliberately a strict subset of the charset and
 * length `spinUpSchema` accepts, so this can change without a coordinated edit there.
 */
export function newIdempotencyKey(): string {
  return randomHex(16);
}
