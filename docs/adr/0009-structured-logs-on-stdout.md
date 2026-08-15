# ADR-9 — Structured logs on stdout, with the OTel seam cut but not used

Before this, the entire server logged through one `console.error` in `report-error.ts`.
It had already computed everything a query would want — the error's kind, HTTP status,
operation name, Railway's `extensions.code`, the refused GraphQL path, the incident id —
and then flattened all of it into a template string that only `grep` could read.

**pino, and stdout only.** Railway captures stdout and nothing else, which the code
already assumed. A shipper is a deployment decision, and no code change should be waiting
on it. What this step buys is the part that is expensive to retrofit: stable event names,
a request id that survives the proxy → render → stream handoff, and an error serializer
that cannot leak a credential.

**`msg` is an event name, not prose.** `container.created`, `auth.session.refresh_failed`.
Around sixty values, which is what makes it usable as a Loki label rather than a
substring search. `reportError`'s existing `scope` argument already had this shape, so it
became the event name unchanged.

**The request id travels as a header, because it has to.** Next's own documentation says
Proxy "is meant to be invoked separately of your render code and in optimized cases
deployed to your CDN, you should not attempt relying on shared modules or globals" — so a
module-level handoff is unavailable in principle, not merely discouraged. The nonce
already rides `forwarded()` for the same reason (ADR-2's neighbour), and the id rides
along with it. Inbound values are never adopted on a proxied path: an attacker-chosen id
is a log-injection vector and an unbounded Loki label. `api/auth` is outside the matcher,
so those handlers mint their own and say so at the call site.

**AsyncLocalStorage on the app side only.** A stream is four layers deep — route →
monitor → api → client — and the monitor outlives the request that created it, so an
argument would have to survive a handoff no argument survives. It works because
`new ReadableStream({ start })` runs `start` synchronously during construction, inside
the handler's scope, so the status poll loop created there stays correlated for the full
fifteen minutes. That is a real invariant with a real test, not a happy accident.

**The error serializer never reads `cause`.** This is the same finding the security
review closed, one library away from returning: pino's stock `err` serializer walks
`cause` recursively, and `cause` is where `oauth4webapi` puts a live access and refresh
token. Three layers now: a field type that makes an object a compile error, an allow-list
serializer, and redact paths as a labelled net. `describeOidcFailure` still owns the OIDC
path, so the raw error never reaches the logger at all. See SECURITY.md.

**`LOG_LEVEL` bypasses `src/env.ts`,** which is the one exception to "all configuration is
validated in env.ts" and is deliberate: `/api/health` exists in order to log `env()`
failing, and a logger that called `env()` could not report that failure. An unrecognised
value clamps rather than throwing, for the same reason `withRequestScope` catches
`headers()` — instrumentation that can fail the thing it observes is worse than none.

**Three lines were tuned by reading real output rather than by reasoning about it,** and
each was the same mistake — a warning that fires on an ordinary event teaches people to
ignore the level. A status poll in flight when a tab closes aborts, which is teardown, not
failure. A render that stops because the user navigated away is Next reporting a
disconnect through the same hook as a genuine throw. And `RailwayApiError` stacks name
this app's own mapper every time, at ~700 bytes a record on the noisiest path, so they are
dropped in favour of the fields that were promoted out of them.

**What is deliberately not logged:** container stdout (the user's data, unbounded, and it
would multiply this deployment's own log volume by every open stream), email and display
name, any token, and successful requests through the proxy — Railway already emits an
access log and this app has no business duplicating it.

**One open question, recorded rather than discovered later.** `formatters.level` emits a
string, because Railway's log viewer colours on one and that is the actual reader today.
The OTel bridge's severity mapping may prefer the number. It is one line in one file and
the field name is the same either way.

---

[All decisions](README.md) · [Railway Freight Loader](../../README.md)
