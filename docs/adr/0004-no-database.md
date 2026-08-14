# ADR-4 — No database

Railway holds the state; mirroring it would only create drift. The dashboard queries
project → services → `latestDeployment` in one request and streams deltas after that.

T-487 tested that boundary and it held. Letting a user set environment variables raised the
obvious question — where does a generated database password get shown? — and the answer is
still nowhere: a user who wants a password they can keep now types their own into the form.
Generation stayed the default for the users who do not care what it is, and a default
nobody has to read is one this app has no reason to store.

---

[All decisions](README.md) · [Railway Freight Loader](../../README.md)
