# ADR-8 — A hand-rolled GraphQL client, not Apollo

**Status:** accepted · **Decided:** 2026-08-14 · **Last revised:** 2026-08-15

## Context

[src/lib/railway/](../../src/lib/railway/) is the largest directory in the app: a transport
(`client.ts`), the documents, typed call sites, error mapping, and a monitor that merges a log
subscription with a status poll. A GraphQL client library is the obvious thing to reach for.

**All of it is server-only.** `client.ts`, `api.ts`, `subscribe.ts` and `deployment-monitor.ts`
each open with `import "server-only"`; the handful of client components that touch this directory
import types and pure helpers exclusively.

## Decision

**Keep the hand-rolled client.** Apollo Client's value is a normalized cache plus hooks in the
browser, and there is no browser-side GraphQL here to give them to — it would put a client bundle
into a budget that has nothing to spend it on.

**A normalized cache would be actively wrong.** The dashboard shows infrastructure that changes
underneath the user; every request is `cache: "no-store"` on purpose. There are two SSE endpoints
and neither carries application state — the second sends empty frames, `changed` and `stale`
([ADR-10](0010-the-dashboard-watches.md)) — so there would be nothing for a cache to normalize
even if one were wanted.

**The subscription path is not Apollo-shaped.** App Router route handlers cannot accept WebSocket
upgrades, so logs arrive over `graphql-ws` upstream and leave over SSE downstream, merged with an
adaptive status poll ([ADR-3](0003-sse-downstream-websocket-upstream.md)). A link chain does not
cross that boundary either way.

**What `client.ts` buys that `RetryLink` does not is Railway-specific:** a 200 response carrying
`errors[]` is a failure; `UNAUTHENTICATED`/`FORBIDDEN` in `extensions` is an auth failure and is
never retried; `Retry-After` and `X-RateLimit-Reset` are honoured against a documented 1,000
req/hour quota.

**The types are generated, not asserted.** Railway's schema is dumped by `pnpm schema:pull` and
committed; `pnpm codegen` derives each document's result and variable types from it; every export
in `operations.ts` is annotated `TypedDocument<Result, Variables>`, so `gql` and `gqlPartial` infer
both and no call site states a shape. A renamed nested field fails `pnpm codegen`, and a wrong
variable fails `pnpm typecheck`. `verify-schema.ts` validates the real documents against Railway's
live schema rather than a hand-written list of root fields — see
[Schema verification](../schema.md).

This is the part a client library is usually reached for, and it is why the hand-rolled client is
not a weaker position than Apollo. A type parameter that is only an assertion lets a renamed nested
field reach the render as `undefined`; codegen is the answer to that, and Apollo does not supply it
either. What it costs here is one generated file and one dev dependency that runs at build time —
`graphql` itself is already a peer of `graphql-ws`.

## Consequences

- **Every document must be regenerated with the code that changes it.** `pnpm codegen:check` is
  part of `pnpm check`: regeneration has to be a no-op.
- **The generated file is committed**, because CI holds no `RAILWAY_TOKEN` and a generated file
  nobody can regenerate is a file nobody can check.
- **The client's error mapping is the one place Railway's non-standard failures are understood**,
  including the 200-with-`Not Authorized` shape described in [Schema verification](../schema.md).

---

[All decisions](README.md) · [Walkthrough](../../walkthrough.md) · [Railway Freight Loader](../../README.md)
