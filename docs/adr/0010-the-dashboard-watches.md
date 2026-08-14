# ADR-10 — The dashboard watches; it does not poll from the browser

A container created, redeployed or destroyed in Railway's own dashboard did not appear
here until someone pressed Refresh. The app was one-way.

**There is nothing to subscribe to.** Railway publishes `deploymentLogs` and `buildLogs`,
both keyed to a single deployment id, and no project, service or deployment-status
subscription — `pnpm verify:schema` introspects the live API and would say otherwise if
that changed. So closing the loop means polling. The only real question is who polls.

**The server does.** `/api/watch/[projectId]` runs one `PROJECT_QUERY` per interval,
hashes the result, and pushes a `changed` event when the hash moves. The browser answers
it with `router.refresh()` and the page re-renders through the normal RSC path.

That beats a `setInterval` in the browser on three counts. It is one Railway request per
user regardless of how many components would have asked. The access token never leaves
the server, which a client-side poll of Railway would require. And `document.visibilityState`
gating costs _literally_ nothing when nobody is looking: the client closes the connection
when the tab is hidden and reopens it on the way back, so a dashboard left open in a
background tab makes no requests at all.

**The payload is one bit.** This endpoint never carries application state — see ADR-8 on
why a normalized cache would be wrong here. The client is told _that_ something changed,
never _what_, which keeps rendering in the one place that knows how.

**The arithmetic.** `WATCH_POLL_MS` defaults to 15s, which is 240 requests/hour against
Hobby's documented 1000 — a quarter of the budget for a tab someone is actually watching.
It is an env var rather than a constant because the right value depends on the plan
behind the token, and the schema floors it at one second so a typo cannot turn a watcher
into a denial of service against the user's own quota.

**What the fingerprint deliberately misses.** It covers the service set and each one's
identity, source, state and deployment id. It excludes `updatedAt`, which Railway bumps
on every deployment tick — including it would refresh the whole page every interval for
the length of a build, a window the row's own deployment stream already owns and already
refreshes at the end of. The cost: redeploying the same image to the same state changes
only `updatedAt` and will not be noticed until something else does. That is the trade,
and `watch-fingerprint.test.ts` pins both halves of it.

**The connection budget, which is what forced a change elsewhere.** Browsers allow six
connections per origin over HTTP/1.1, and `next start` speaks HTTP/1.1. One is now the
watcher and one is reserved for RSC navigation and Server Action fetches, which share the
same pool — so `STREAM.MAX_CONCURRENT_PER_USER` came down from 8 to 4. It was above the
browser's own limit before, which meant the cap that actually applied was invisible: the
seventh EventSource did not fail, it queued, with nothing on the wire and nothing in any
log.

**Not done, and named rather than left implicit:** a client-side connection registry that
defers streams past the limit instead of letting the browser queue them silently. Lowering
the server cap makes the refusal legible; it does not make the browser's own queueing go
away.

---

[All decisions](README.md) · [Railway Freight Loader](../../README.md)
