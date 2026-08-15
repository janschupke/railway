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

The boundary has been tested twice since, and it held both times.

**Environment variables (T-487).** Letting a user set them raised the obvious question — where
does a generated database password get shown? — and the answer is still nowhere: a user who wants
a password they can keep types their own into the form. Generation stayed the default for the
users who do not care what it is, and a default nobody has to read is one this app has no reason
to store.

**Double-submit protection (T-494).** It wants somewhere to remember which submission produced
which container, and the honest answer was a map with a five-minute TTL rather than a table —
request bookkeeping, not state, and nothing in it a database would be asked to survive.
[ADR-12](0012-idempotency-keys-replay-rather-than-reject.md) prices what that costs.

The same test applies to the other per-process caches — the region list and the registry's
answer cache. Each has an expiry and nothing behind it that has to survive a restart.

---

[All decisions](README.md) · [Walkthrough](../../walkthrough.md) · [Railway Freight Loader](../../README.md)
