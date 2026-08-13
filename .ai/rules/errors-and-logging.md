---
meta:
  updated: 2026-08-13
---

# Errors and logging

Two halves of one rule: **the full failure goes to the log, a catalog key goes to the
browser.** Everything below follows from that.

## Server Actions return a result; they do not throw at the UI

`src/lib/action-result.ts`:

```ts
type ActionResult =
  { ok: true; message: string } | { ok: false; error: string; field?: ActionField };
```

`describeActionError(error)` turns any thrown value into a `MessageDescriptor` the caller
resolves. It short-circuits `SessionExpiredError` at `info` — an expired session is the
ordinary end of a session's life, not an anomaly — and sends everything else to
`reportError`.

Attribute a validation failure to its field (`"name"`, `"image"`) so the form can point at
it. Add a new field name to `ActionField` and `isField` together.

## `reportError` is the one bridge between what failed and what we are willing to say

`src/lib/report-error.ts`:

```ts
reportError(scope, error, fallback): MessageDescriptor;
```

- Logs the full failure — including everything the error carries — against an 8-hex
  `incident` id (`src/lib/incident.ts`), kept top-level rather than under `err` because it is
  the join key between a user's screenshot and a log line.
- Returns `{ key, values: { incident } }`, or the `RailwayApiError`'s own classified
  descriptor. **The browser sees a catalog key and an id. Never upstream text.**
- `scope` names the _operation_, not the error — `"railway.logStream"`, `"action"` — and is
  emitted as the record's event name, so a subsystem is a query rather than a substring
  match.

Do not build an error string and render it. Do not add a `detail` value to an error message.
Both were real findings (3 and 4 in [SECURITY.md](../../SECURITY.md)).

## Errors that classify themselves

`RailwayApiError` (`src/lib/railway/errors.ts`) carries its own incident id and `describe()`
result, so a rejected credential, a withheld scope, a rate limit and an outage each map to
their own sentence. That classification exists because the first redaction pass collapsed
them into one message, and a user who cannot tell those apart cannot tell whether to retry,
re-authorize, or stop. Keep the branches.

## The logger takes scalars and one sanctioned error

`src/lib/logger.ts` exposes `log.debug|info|warn|error(event, fields?)`. The `fields` type is
`LogFields<T>` — **scalars only, with `error` as the single non-scalar key allowed**. Passing
a session, a token response, or a bare `Error` under any other name is a compile error.

That narrowness is deliberate: pino's serializers are keyed by field _name_, so `{ err }`
instead of `{ error }` would get no serializer at all, and the leak is one character wide.

Four enforcers, in the order they fire:

1. The `LogFields` type at the call site.
2. `errorFields` (`src/lib/log/serialize-error.ts`) — a named allow-list. Never touches
   `cause` at any depth, never enumerates keys, never `String()`s a non-Error object.
3. `describeOidcFailure` — keeps raw OIDC errors out of the logging path entirely.
4. pino `redact` paths — a labelled backstop, one level deep, and the comment says so.

## `msg` is a stable event name from a bounded set

One JSON line per event on stdout. `msg` is an identifier, not a sentence:
`auth.session.refreshed`, `container.created`, `container.destroy_refused`,
`proxy.env_invalid`, `railway.request.retry`, `stream.opened`, `watch.poll_failed`.

Fields that recur: `request_id` (minted in `src/proxy.ts`, never adopted from the request),
`subject_id`, `route` as a **static pattern** — `/api/streams/[deploymentId]`, not the
resolved path — `incident`, and `err.*`.

**Bounded cardinality is the point.** A field whose values are unbounded and
attacker-controlled does not go in a record an operator greps; that is why the rejected
`deploymentId` is not logged and `id_length` carries the diagnostic content instead.

Prefer an existing event name over a near-duplicate. If you add one, keep the
`subsystem.thing.outcome` shape.

## Never logged

Email, display name, profile image, access / refresh / id tokens, `Error.cause`, the sealed
cookie, container stdout.

`Error.cause` is where `oauth4webapi` puts a live access token
(`UnsupportedOperationError("unsupported token_type value", { cause: { body: json } })`), and
Railway retains stdout, so one such line outlives the request that produced it. That is
finding 2, and finding 10 is the same hazard arriving through pino's default `err`
serializer.

Auth events and state-changing actions are logged at `info` or `warn` on purpose — that is
the audit trail Railway does not keep once a service is deleted.

## `no-console` is a security ratchet

`no-console: error` across `src/**`. `e2e/**` and `scripts/**` are exempt because they print
aligned tables for a person at a terminal, where JSON would be a regression.

Exactly one inline disable exists, in `src/app/dashboard/error.tsx`, which runs in the
browser. **Do not add a second one** without the same kind of justification — a stray
`console.error(error)` is how the token leak got in.

There is no client-to-server error channel, and `src/instrumentation.ts` is not one:
`onRequestError` is a **server** hook for **server** render failures and never sees a
browser-side throw. `dashboard/error.tsx` writes to the browser console and stops, handing
the user a digest that joins to the server's own `render.failed` record.

Building a real channel would mean a POST endpoint, its own rate limit, a CSP review and a
new unauthenticated write surface — deliberately not done. A client component cannot import
`lib/logger` at all; see [architecture.md](architecture.md).

## `LOG_LEVEL` is the one config that skips `src/env.ts`

Read straight from `process.env`, clamping silently on an unrecognised value, for three
reasons stated in the file: `/api/health` exists in order to log `env()` failing, `proxy.ts`
calls `env()` per request and a throwing logger would make a misconfigured deployment a
silent boot loop, and `env()` is a memo with a test reset — the wrong lifetime for a
process-lifetime singleton. **A logger must never be the component that refuses to start.**

## Before you call this done

Any change on a token, session or error path needs a canary. Grep the existing ones:

```sh
grep -rn "rawLogLines\|logRecords" src --include='*.test.ts'
```

Then:

```sh
pnpm test src/lib/logger.test.ts src/lib/log src/lib/report-error.test.ts src/lib/action-result.test.ts
```
