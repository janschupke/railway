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
`undefined`. The answer to that is codegen, which Apollo does not provide either.

## Update, 2026-08-14 — the gap is closed, and the decision stands

The paragraph above is what T-476 acted on, and the answer was the one it named: codegen, not
a client library. Railway's schema is dumped by `pnpm schema:pull` and committed, `pnpm codegen`
generates each document's result and variable types from it, and every export in
`operations.ts` is annotated `TypedDocument<Result, Variables>` — so `gql` and `gqlPartial`
infer both and no call site states a shape. A renamed nested field fails `pnpm codegen`; a
wrong variable fails `pnpm typecheck`. `verify-schema.ts` now validates the real documents
against Railway's live schema instead of a hand-written list of root fields.

That strengthens this decision rather than weakening it. Everything Apollo was rejected for
is untouched — there is still no browser-side GraphQL, still no cache to normalize, still a
`graphql-ws`-to-SSE bridge no link chain crosses — and the one thing it was missing arrived
without it. What was added is 345 generated lines and one dev dependency that runs at build
time; `graphql` itself is a peer of `graphql-ws`, which this app already had.

---

[All decisions](README.md) · [Railway Freight Loader](../../README.md)
