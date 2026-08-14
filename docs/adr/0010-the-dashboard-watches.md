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
why a normalized cache would be wrong here. The client is told _that_ it should re-render,
never _what_ changed, which keeps rendering in the one place that knows how.

**There are two reasons to send that bit, and neither carries anything.** `changed` means
the service set moved. `stale` means the CPU, memory and uptime readouts have aged past
`METRICS_POLL_MS` — those are read on the render rather than polled (see below), so on a
project where nothing is changing they would otherwise sit at whatever they were when the
page loaded, which is most of the time.

The staleness clock lives on the server, and that is the whole reason it is affordable: the
poll loop has just read the container list, so it knows whether anything is _running_ to be
stale about. An environment of stopped containers gets no nudge and therefore costs nothing.
A `setInterval` in the hook would fire regardless and spend the same quota to re-render
readouts that cannot have moved.

**Usage is read on the render, not pushed down this wire.** `getProjectMetrics` runs in the
RSC path beside the container list, and a nudge is just another reason to render. Pushing
the numbers through the watcher instead would mean a client store to distribute them to the
rows — which ADR-7 rejects by name, and which ADR-8's "there is nothing for a cache to
normalize" leans on. One readout is not worth invalidating a sentence in two other decisions.

**The arithmetic.** `WATCH_POLL_MS` defaults to 15s, which is 240 requests/hour against
Hobby's documented 1000 — a quarter of the budget for a tab someone is actually watching.
`METRICS_POLL_MS` defaults to 120s, so a visible dashboard forces at most 30 extra renders
an hour; a render is four Railway requests now rather than three, because `ProjectMetrics`
runs in parallel with `Project`. One request covers every service in the environment —
`groupBy: [SERVICE_ID]` — so that figure does not grow with the list.

```
watcher      15s  → 240/hour                    (unchanged)
nudge       120s  → ≤ 30 renders/hour × 4 reqs = 120/hour
                    ─────────────────────────────────────
                    360 / 1000 (Hobby), up from 240
```

`METRICS_POLL_MS=0` disables the readouts outright and returns that to 240. For scale
against the rest of the budget, four concurrent log streams are ~270/hour on their own
(see `STREAM.MAX_POLL_MS`), so a busy tab sits near 630.

Both are env vars rather than constants because the right value depends on the plan behind
the token, and both are floored at one second — a sanity bound rather than the quota
protection, since a one-second watcher is already 3,600 requests an hour against 1,000.
What the floor actually buys is the end-to-end suite: a spec can drive either cadence
without waiting out a production one.

**What the fingerprint deliberately misses.** It covers the service set and each one's
identity, source, state and deployment id. It excludes `updatedAt`, which Railway bumps
on every deployment tick — including it would refresh the whole page every interval for
the length of a build, a window the row's own deployment stream already owns and already
refreshes at the end of. The cost: redeploying the same image to the same state changes
only `updatedAt` and will not be noticed until something else does. That is the trade,
and `watch-fingerprint.test.ts` pins both halves of it.

It also never sees a metric value, and that is structural rather than remembered: usage
lives in a `Record<serviceId, ContainerMetrics>` beside the container list, not on
`Container`, so `fingerprint()` cannot hash a number it is never handed. A fluctuating CPU
float in that hash would announce a change on every single tick, forever.

**The connection budget, which is what forced a change elsewhere.** Browsers allow six
connections per origin over HTTP/1.1, and the server this app ships speaks HTTP/1.1. One is
now the watcher and one is reserved for RSC navigation and Server Action fetches, which share the
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
