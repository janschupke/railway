# ADR-3 — SSE downstream, WebSocket upstream

Railway streams build and deploy logs as GraphQL subscriptions over
`wss://backboard.railway.com/graphql/v2` — the same transport `railway logs` uses. So
log lines are genuinely pushed.

The browser leg is SSE, not WebSocket, because Next's App Router cannot accept WebSocket
upgrades in a route handler, and the data only flows one way. No custom server needed.

**Status is the honest exception, and the reason is a cost rather than an absence.**
Railway does publish `Subscription.deployment(id:)` — "Subscribe to updates for a specific
deployment", carrying a non-null `status`. This ADR said for a long time that it did not,
and that was wrong; `pnpm probe:subscription` establishes it against the live API, with a
control that shows the server rejecting a field it genuinely lacks and accepting this one.

Status is polled anyway, and this is the argument that should have been here:

- **It is a second upstream socket per open stream.** Every log pane already holds one
  `graphql-ws` connection; subscribing to status doubles that against
  `STREAM.MAX_CONCURRENT_PER_USER`, which is the cap standing between one visitor and this
  process's sockets.
- **The poll is already adaptive and mostly idle.** It stretches towards `MAX_POLL_MS` for
  every four polls reporting the same state, so a deployment that sits still costs very
  little — while a subscription costs a held connection whether anything moves or not.
- **The terminal state has to be detected either way.** The stream closes when the
  deployment reaches one, and a poll that returns it is the same event a push would be.

What is **not** established: whether a delegated OAuth grant — the credential this app
actually holds — may open that subscription, as opposed to the account token the probe ran
with. `pnpm probe:subscription` with `RC_SESSION` set answers that, and nobody has run it.
Settle that before building on the field.

The poll is bounded to one deployment, only while it is transitioning, with the whole
stream closing at a terminal state.

One poll at a time, and the gap between them is not fixed: 2.5s while the deployment is
moving, stretching towards `STREAM.MAX_POLL_MS` for every four polls that report the same
state, and doubling to `STREAM.MAX_BACKOFF_MS` after a failure. A flat 2.5s was 360
requests per fifteen-minute stream and 1,440 an hour for the four a user may hold, against
Hobby's 1,000 — the status poll alone over the quota, before the watcher or a single
render. A deployment that is actually progressing still polls at the base rate throughout,
because every state change resets the ladder.

The dashboard as a whole is polled too, and deliberately: see ADR-10, which covers the
cost of that and why it is paid on the server rather than in the browser.

---

[All decisions](README.md) · [Railway Freight Loader](../../README.md)
