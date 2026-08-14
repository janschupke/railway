# ADR-2 — Token refresh runs in the proxy layer

Railway access tokens live **one hour** and refresh tokens **rotate on every use**. A
demo that dies 60 minutes in is the specific failure this app invites, so refresh is not
an afterthought.

Server Components can read cookies but not write them, so a refresh during render would
rotate the token and then lose it — and the spent refresh token is gone. Refresh
therefore runs in `src/proxy.ts`, which executes before the render and _can_ write. The
new cookie is set on the **request** as well as the response, so the render that
triggered the refresh already sees the fresh token. Server Actions and Route Handlers
carry a fallback path (`requireAccessToken`) since they can write cookies too.

**Rotation makes concurrency the hard part.** One dashboard load puts many requests
through the proxy holding the same cookie — the document, its RSC payloads, and every
open log stream — and each of them used to open its own grant with the same refresh
token. Railway invalidates that token on first use, so one won and the rest received
`invalid_grant`, concluded the session was dead, and deleted the cookie holding the
refresh that had just succeeded. That is what manufactured the repeated authorizations.
Two things fix it: `refreshSession` shares one in-flight grant per token, and the
proxy's failure branch re-reads the cookie before clearing anything, so a request that
lost a race adopts the winner's session instead of destroying it.

---

[All decisions](README.md) · [Railway Freight Loader](../../README.md)
