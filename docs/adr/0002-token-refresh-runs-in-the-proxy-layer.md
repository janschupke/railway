# ADR-2 — Token refresh runs in the proxy layer

**Status:** accepted · **Decided:** 2026-08-14

## Context

Railway access tokens live **one hour** and refresh tokens **rotate on every use**. A demo that
dies 60 minutes in is the specific failure this app invites, so refresh is not an afterthought.

Server Components can read cookies but not write them, so a refresh during render would rotate
the token and then lose it — and the spent refresh token is gone.

## Decision

**Refresh in [`src/proxy.ts`](../../src/proxy.ts)**, which executes before the render and _can_
write. The new cookie is set on the **request** as well as the response, so the render that
triggered the refresh already sees the fresh token. Server Actions and Route Handlers carry a
fallback path (`requireAccessToken`) since they can write cookies too.

**Rotation makes concurrency the hard part**, and two things handle it. `refreshSession` shares
one in-flight grant per token, and the proxy's failure branch re-reads the cookie before clearing
anything, so a request that lost a race adopts the winner's session instead of destroying it.

## Consequences

**Both halves of the concurrency handling are load-bearing, and the failure they prevent is
silent.** One dashboard load puts many requests through the proxy holding the same cookie — the
document, its RSC payloads, and every open log stream. Without the shared in-flight grant each
opens its own with the same refresh token; Railway invalidates that token on first use, so one
wins and the rest receive `invalid_grant`. Without the re-read before clearing, those losers
conclude the session is dead and delete the cookie holding the refresh that had just succeeded.
The symptom is being asked to authorize again, repeatedly, for no reason the user can see.

---

[All decisions](README.md) · [Walkthrough](../../walkthrough.md) · [Railway Freight Loader](../../README.md)
