# ADR-4 — No database

Railway holds the state; mirroring it would only create drift. The dashboard queries
project → services → `latestDeployment` in one request and streams deltas after that.

T-487 tested that boundary and it held. Letting a user set environment variables raised the
obvious question — where does a generated database password get shown? — and the answer is
still nowhere: a user who wants a password they can keep now types their own into the form.
Generation stayed the default for the users who do not care what it is, and a default
nobody has to read is one this app has no reason to store.

T-494 tested it again from the other side. Double-submit protection wants somewhere to
remember which submission produced which container, and the honest answer was a map with a
five-minute TTL rather than a table — request bookkeeping, not state, and nothing in it a
database would be asked to survive. [ADR-12](0012-idempotency-keys-replay-rather-than-reject.md)
prices what that costs.

---

[All decisions](README.md) · [Railway Freight Loader](../../README.md)
