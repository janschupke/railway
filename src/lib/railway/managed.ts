import { env } from "@/env";
import { managedSlug } from "./slug";

/**
 * Ownership marker.
 *
 * Railway services carry no arbitrary metadata or labels, so there is nowhere to hang
 * a machine-readable "created by this app" tag that can be read back in the same query
 * that lists services. A service *variable* would work but costs an extra round-trip
 * per service on every list render, against a low rate limit.
 *
 * So the name prefix is the marker. It is cosmetic and a user could forge it by
 * renaming a service in the Railway dashboard — an acceptable trade, because the blast
 * radius is bounded by the OAuth scopes the user themselves granted, and the prefix is
 * visible in Railway's own UI rather than hidden metadata.
 *
 * The rule this enforces: **this app only ever destroys services it created.**
 */

export function managedPrefix(): string {
  return env().MANAGED_PREFIX;
}

/** `My Redis!` -> `spun-my-redis` */
export function toManagedName(input: string): string {
  return `${managedPrefix()}${managedSlug(input)}`;
}

export function isManagedName(name: string): boolean {
  return name.startsWith(managedPrefix());
}

export function stripPrefix(name: string): string {
  return isManagedName(name) ? name.slice(managedPrefix().length) : name;
}
