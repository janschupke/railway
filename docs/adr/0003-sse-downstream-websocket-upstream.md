# ADR-3 — SSE downstream, WebSocket upstream

**Status:** accepted · **Decided:** 2026-08-14 · **Last revised:** 2026-08-15

## Context

Railway streams build and deploy logs as GraphQL subscriptions over
`wss://backboard.railway.com/graphql/v2` — the same transport `railway logs` uses. So log lines
are genuinely pushed, and the app has to carry them to an open tab.

Next's App Router cannot accept WebSocket upgrades in a route handler.

## Decision

**Logs arrive over `graphql-ws` upstream and leave over SSE downstream.** The data only flows one
way, so SSE is the right shape for the browser leg and no custom server is needed.

**Status is polled, not subscribed.** Railway does publish `Subscription.deployment(id:)` —
"Subscribe to updates for a specific deployment", carrying a non-null `status` —
and `pnpm probe:subscription` establishes that against the live API, with a control that shows
the server rejecting a field it genuinely lacks and accepting this one. Polling it anyway is a
cost decision, on three grounds:

- **It would be a second upstream socket per open stream.** Every log pane already holds one
  `graphql-ws` connection; subscribing to status doubles that against
  `STREAM.MAX_CONCURRENT_PER_USER`, which is the cap standing between one visitor and this
  process's sockets.
- **The poll is already adaptive and mostly idle.** It stretches towards `STREAM.MAX_POLL_MS` for
  every four polls reporting the same state, so a deployment that sits still costs very little —
  while a subscription costs a held connection whether anything moves or not.
- **The terminal state has to be detected either way.** The stream closes when the deployment
  reaches one, and a poll that returns it is the same event a push would be.

The poll is bounded to one deployment, only while it is transitioning, with the whole stream
closing at a terminal state. One poll at a time, and the gap between them is not fixed: 2.5 s
while the deployment is moving, stretching towards `STREAM.MAX_POLL_MS` for every four polls that
report the same state, and doubling to `STREAM.MAX_BACKOFF_MS` after a failure. A deployment that
is actually progressing polls at the base rate throughout, because every state change resets the
ladder.

A flat 2.5 s was 360 requests per fifteen-minute stream and 1,440 an hour for the four a user may
hold, against Hobby's 1,000 — the status poll alone over the quota, before the watcher or a single
render.

## Consequences

- **The whole dashboard is polled too, and deliberately.** [ADR-10](0010-the-dashboard-watches.md)
  covers the cost of that and why it is paid on the server rather than in the browser.
- **The bridge is not something a GraphQL client library crosses.**
  [ADR-8](0008-a-hand-rolled-graphql-client-not-apollo.md) rests on that.

### Open question

Whether a **delegated OAuth grant** — the credential this app actually holds — may open that
subscription, as opposed to the account token the probe ran with, is not established.
`pnpm probe:subscription` with `RC_SESSION` set answers it, and nobody has run it. Settle that
before building on the field.

---

[All decisions](README.md) · [Walkthrough](../../walkthrough.md) · [Railway Freight Loader](../../README.md)
