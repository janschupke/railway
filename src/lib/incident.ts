/**
 * Identifiers that tie a sentence the user sees to the log line that explains it.
 *
 * Deliberately import-light. Both `RailwayApiError` (which mints one per failure) and
 * `reportError` (which logs against it) need this, and they already depend on each
 * other — putting the generator here is what keeps that graph acyclic. Its one import
 * is ./random-id, which is itself import-free for the same kind of reason.
 */

import { randomHex } from "./random-id";

/** Eight hex chars: enough to grep a log for, too short to be worth enumerating. */
export function newIncidentId(): string {
  return randomHex(4);
}
