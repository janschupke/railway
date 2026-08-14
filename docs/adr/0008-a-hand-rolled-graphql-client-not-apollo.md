# ADR-8 — A hand-rolled GraphQL client, not Apollo

`src/lib/railway/` is 1072 lines covering ten operations: a transport (`client.ts`), the
documents, typed call sites, error mapping, and a monitor that merges a log subscription
with a status poll.

**All of it is server-only.** `client.ts`, `api.ts`, `subscribe.ts` and
`deployment-monitor.ts` each open with `import "server-only"`; the five client
components that touch this directory import types and pure helpers exclusively. Apollo
Client's value is a normalized cache plus hooks in the browser — there is no
browser-side GraphQL here to give them to, and it would put ~35 kB gzip into a bundle
that is gated at 209 kB.

**A normalized cache would be actively wrong.** The dashboard shows infrastructure that
changes underneath the user; every request is `cache: "no-store"` on purpose. There are
two SSE endpoints now and neither carries application state — the second one sends empty
frames, `changed` and `stale` (ADR-10), so there would be nothing for a cache to normalize
even if one were wanted.

**The subscription path is not Apollo-shaped.** App Router route handlers cannot accept
WebSocket upgrades, so logs arrive over `graphql-ws` upstream and leave over SSE
downstream, merged with a status poll — starting at 2.5s and stretching as a deployment
sits still — because Railway exposes no deployment-status subscription. A link chain does
not cross that boundary.

**What `client.ts` buys that `RetryLink` does not** is Railway-specific: a 200 response
carrying `errors[]` is a failure; `UNAUTHENTICATED`/`FORBIDDEN` in `extensions` is an
auth failure and is never retried; `Retry-After` and `X-RateLimit-Reset` are honoured
against a documented 1000 req/hour quota.

**The real gap, and why Apollo is not the fix.** The type parameter on `gql<T>()` is an
unchecked assertion, and `verify-schema.ts` proves root field and argument _existence_,
not selection sets or nullability — so a renamed nested field surfaces as a runtime
`undefined`. The answer to that is codegen, which Apollo does not provide either. It is
in "What I would do next".

---

[All decisions](README.md) · [Railway Freight Loader](../../README.md)
