# ADR-3 — SSE downstream, WebSocket upstream

Railway streams build and deploy logs as GraphQL subscriptions over
`wss://backboard.railway.com/graphql/v2` — the same transport `railway logs` uses. So
log lines are genuinely pushed.

The browser leg is SSE, not WebSocket, because Next's App Router cannot accept WebSocket
upgrades in a route handler, and the data only flows one way. No custom server needed.

**Status is the honest exception.** Railway exposes log subscriptions but no
deployment-status subscription, so status is polled — bounded to one deployment, only
while it is transitioning, with the whole stream closing at a terminal state.

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
