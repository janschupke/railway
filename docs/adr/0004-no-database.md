# ADR-4 — No database

**Status:** accepted · **Decided:** 2026-08-14

## Context

This app renders a live view of infrastructure that Railway owns. Anything it stored about that
infrastructure would be a second copy of a fact Railway already holds.

## Decision

**Railway holds the state; this app stores none of it.** The dashboard queries project →
services → `latestDeployment` in one request and streams deltas after that. Mirroring any of it
would only create drift.

## Consequences

Two features sit close enough to the boundary to say where they land.

**Environment variables.** A generated database password is shown nowhere: a user who wants a
password they can keep types their own into the form, and generation is the default only for the
users who do not care what it is. A default nobody has to read is one this app has no reason to
store.

**Double-submit protection.** Remembering which submission produced which container is a map with
a five-minute TTL rather than a table — request bookkeeping, not state, and nothing in it a
database would be asked to survive.
[ADR-12](0012-idempotency-keys-replay-rather-than-reject.md) prices what that costs.

The same test applies to the other per-process caches — the region list and the registry's
answer cache. Each has an expiry and nothing behind it that has to survive a restart.

**One piece of state has no expiry, and it is the exception this ADR has to name.** Railway
answers `deploymentStop` with `true`, genuinely stops the container, and leaves
`deployment.status` at `SUCCESS` indefinitely — there is no terminal status for a stopped
deployment and no field anywhere that says one is stopped. So the app remembers what it stopped,
in [src/lib/railway/stopped.ts](../../src/lib/railway/stopped.ts), and renders those containers
`removed` until Railway reports something else about them.

It fails the "has an expiry" half of the test above, and deliberately: the watch fingerprint
hashes container state, so an entry that timed out would flip the hash back and push a `changed`
to every open tab — a still-stopped container silently returning to **Running**, announced. The
map is bounded by size instead and cleared explicitly by every other lifecycle verb.

It passes the half that matters more. Nothing behind it has to survive a restart, and what a
restart costs is precisely the pre-existing bug: a stopped row reads Running again, which is what
it did before this existed. A database would make that reading correct across restarts and would
buy nothing else — which is a small enough prize that the decision stands, but it is a real
consequence and [Limitations](../limitations.md#single-replica-and-the-state-that-says-so) names
it beside the other two.

---

[All decisions](README.md) · [Walkthrough](../../walkthrough.md) · [Railway Freight Loader](../../README.md)
