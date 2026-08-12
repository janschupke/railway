/**
 * Identifiers that tie a sentence the user sees to the log line that explains it.
 *
 * Deliberately import-free. Both `RailwayApiError` (which mints one per failure) and
 * `reportError` (which logs against it) need this, and they already depend on each
 * other — putting the generator here is what keeps that graph acyclic.
 */

/** Eight hex chars: enough to grep a log for, too short to be worth enumerating. */
export function newIncidentId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
