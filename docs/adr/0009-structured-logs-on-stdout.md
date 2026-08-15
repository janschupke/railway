# ADR-9 — Structured logs on stdout, with the OTel seam cut but not used

**Status:** accepted · **Decided:** 2026-08-14

## Context

`report-error.ts` already computes everything a query would want about a failure — the error's
kind, HTTP status, operation name, Railway's `extensions.code`, the refused GraphQL path, the
incident id. Emitting that through `console.error` flattens all of it into one template string,
which makes every one of those fields reachable only by substring search.

## Decision

**pino, and stdout only.** Railway captures stdout and nothing else, which the code already
assumed. A shipper is a deployment decision, and no code change should be waiting on it. What
this buys is the part that is expensive to retrofit: stable event names, a request id that
survives the proxy → render → stream handoff, and an error serializer that cannot leak a
credential. The field reference is in [docs/logs.md](../logs.md).

**`msg` is an event name rather than prose** — `container.created`,
`auth.session.refresh_failed`. It is drawn from a bounded set, which is what makes it usable as a
Loki label rather than a substring search. `reportError`'s `scope` argument already had this
shape and is the event name unchanged.

**The request id travels as a header, because it has to.** Next's own documentation says Proxy
"is meant to be invoked separately of your render code and in optimized cases deployed to your
CDN, you should not attempt relying on shared modules or globals" — so a module-level handoff is
unavailable in principle, not merely discouraged. The CSP nonce already rides `forwarded()` for
the same reason, and the id rides along with it. Inbound values are never adopted on a proxied
path: an attacker-chosen id is a log-injection vector and an unbounded Loki label. `api/auth` is
outside the matcher, so those handlers mint their own and say so at the call site.

**AsyncLocalStorage on the app side only.** A stream is four layers deep — route → monitor → api →
client — and the monitor outlives the request that created it, so an argument would have to survive
a handoff no argument survives. It works because `new ReadableStream({ start })` runs `start`
synchronously during construction, inside the handler's scope, so the status poll loop created
there stays correlated for the full fifteen minutes. It is an invariant of that constructor rather
than an accident of ordering, and a test holds it.

**The error serializer never reads `cause`.** This is the same finding the security review closed,
one library away from returning: pino's stock `err` serializer walks `cause` recursively, and
`cause` is where `oauth4webapi` puts a live access and refresh token. Three layers now: a field
type that makes an object a compile error, an allow-list serializer, and redact paths as a
labelled net. `describeOidcFailure` still owns the OIDC path, so the raw error never reaches the
logger at all. See [SECURITY.md](../../SECURITY.md).

**`LOG_LEVEL` bypasses `src/env.ts`,** which is the one exception to "all configuration is
validated in env.ts" and is deliberate: `/api/health` exists in order to log `env()` failing, and a
logger that called `env()` could not report that failure. An unrecognised value clamps rather than
throwing, for the same reason `withRequestScope` catches `headers()` — instrumentation that can
fail the thing it observes is worse than none.

## Consequences

**Three levels were tuned by reading real output rather than by reasoning about it,** and each was
the same mistake: a warning that fires on an ordinary event teaches people to ignore the level. A
status poll in flight when a tab closes aborts, which is teardown, not failure. A render that stops
because the user navigated away is Next reporting a disconnect through the same hook as a genuine
throw. And `RailwayApiError` stacks name this app's own mapper every time, at ~700 bytes a record
on the noisiest path, so they are dropped in favour of the fields promoted out of them.

**What is deliberately not logged:** container stdout (the user's data, unbounded, and it would
multiply this deployment's own log volume by every open stream), email and display name, any token,
and successful requests through the proxy — Railway already emits an access log and this app has no
business duplicating it.

**Shipping the logs is a deployment change and no code change.** Add the OTel packages, add
`register()` to [src/instrumentation.ts](../../src/instrumentation.ts), point a collector at
Railway's log drain. Nothing in `src/**` outside that one file should need to change — that is the
test of whether the seam was cut in the right place.

### Open question

`formatters.level` emits a string, because Railway's log viewer colours on one and that is the
actual reader today. The OTel bridge's severity mapping may prefer the number. It is one line in
one file and the field name is the same either way.

---

[All decisions](README.md) · [Walkthrough](../../walkthrough.md) · [Railway Freight Loader](../../README.md)
